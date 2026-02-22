import {
  createDecipheriv,
  createPublicKey,
  diffieHellman,
  hkdfSync,
} from 'node:crypto';

import type { AppConfig } from '../lib/config';
import { DecryptionError } from '../lib/errors';

const FRAME_IV_LENGTH = 12;
const FRAME_AUTH_TAG_LENGTH = 16;
const V2_MAGIC = Buffer.from('AWR2', 'ascii');
const V2_VERSION = 2;

export interface DecryptedPayload {
  metadata: Record<string, unknown>;
  data?: Buffer;
  transportVersion: 'v1' | 'v2';
  keyId?: string;
}

export interface ReplayValidationOptions {
  ttlMs: number;
  clockSkewMs: number;
  nowMs?: number;
}

export interface ReplayValidationResult {
  metadata: Record<string, unknown>;
  timestamp: number;
  nonce: string;
}

/**
 * Decrypt a relay transport payload (legacy v1 or hybrid-envelope v2) and parse:
 * [4B metadataLen][metadata JSON][optional raw binary data]
 */
export function decryptPayload(
  gameData: string,
  config: Pick<AppConfig, 'transportCryptoMode' | 'encryptionKey' | 'transportV2Key'>,
): DecryptedPayload {
  const blob = Buffer.from(gameData, 'base64');
  if (blob.length === 0) {
    throw new DecryptionError('Encrypted payload is empty');
  }

  try {
    if (isV2Envelope(blob)) {
      return decryptPayloadV2(blob, config);
    }

    if (config.transportCryptoMode === 'v2') {
      throw new DecryptionError('Legacy v1 transport is disabled on this server');
    }

    if (!config.encryptionKey) {
      throw new DecryptionError('Server is not configured with legacy ENCRYPTION_KEY');
    }

    return decryptPayloadV1(blob, config.encryptionKey);
  } catch (err) {
    if (err instanceof DecryptionError) {
      throw err;
    }

    const message = err instanceof Error ? err.message : String(err);
    if (message.toLowerCase().includes('auth')) {
      throw new DecryptionError('Data integrity check failed — data may have been tampered');
    }
    throw new DecryptionError(`Decryption failed: ${message}`);
  }
}

export function validateAndStripReplayMetadata(
  metadata: Record<string, unknown>,
  options: ReplayValidationOptions,
): ReplayValidationResult {
  const timestampValue = metadata.timestamp;
  const nonceValue = metadata.nonce;

  if (!Number.isInteger(timestampValue)) {
    throw new DecryptionError('Missing or invalid encrypted metadata field: timestamp');
  }
  if (typeof nonceValue !== 'string' || nonceValue.length < 8 || nonceValue.length > 256) {
    throw new DecryptionError('Missing or invalid encrypted metadata field: nonce');
  }

  const nowMs = options.nowMs ?? Date.now();
  const timestamp = timestampValue as number;
  if (timestamp < nowMs - options.ttlMs) {
    throw new DecryptionError('Encrypted request metadata timestamp is expired');
  }
  if (timestamp > nowMs + options.clockSkewMs) {
    throw new DecryptionError('Encrypted request metadata timestamp is too far in the future');
  }

  const stripped = { ...metadata };
  delete stripped.timestamp;
  delete stripped.nonce;

  return {
    metadata: stripped,
    timestamp,
    nonce: nonceValue,
  };
}

function decryptPayloadV1(blob: Buffer, key: Buffer): DecryptedPayload {
  if (key.length !== 32) {
    throw new DecryptionError(
      `Invalid encryption key length: expected 32 bytes, got ${key.length}`,
    );
  }

  if (blob.length < FRAME_IV_LENGTH + FRAME_AUTH_TAG_LENGTH + 1) {
    throw new DecryptionError('Encrypted payload is too small');
  }

  const iv = blob.subarray(0, FRAME_IV_LENGTH);
  const authTag = blob.subarray(FRAME_IV_LENGTH, FRAME_IV_LENGTH + FRAME_AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(FRAME_IV_LENGTH + FRAME_AUTH_TAG_LENGTH);

  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const { metadata, data } = parsePlaintextFrame(plaintext);
  return { metadata, data, transportVersion: 'v1' };
}

function decryptPayloadV2(
  blob: Buffer,
  config: Pick<AppConfig, 'transportCryptoMode' | 'transportV2Key'>,
): DecryptedPayload {
  if (config.transportCryptoMode === 'v1') {
    throw new DecryptionError('v2 transport is disabled on this server');
  }
  if (!config.transportV2Key) {
    throw new DecryptionError('Server is not configured for v2 transport decryption');
  }

  const minHeader = V2_MAGIC.length + 1 + 1 + 2 + FRAME_IV_LENGTH + FRAME_AUTH_TAG_LENGTH;
  if (blob.length < minHeader) {
    throw new DecryptionError('v2 encrypted payload is too small');
  }

  let offset = V2_MAGIC.length;
  const version = blob.readUInt8(offset);
  offset += 1;
  if (version !== V2_VERSION) {
    throw new DecryptionError(`Unsupported transport version: ${version}`);
  }

  const kidLength = blob.readUInt8(offset);
  offset += 1;
  const ephemeralKeyLength = blob.readUInt16BE(offset);
  offset += 2;
  const ivStart = offset;
  const ivEnd = ivStart + FRAME_IV_LENGTH;
  const iv = blob.subarray(ivStart, ivEnd);
  offset = ivEnd;

  const headerLength = V2_MAGIC.length + 1 + 1 + 2 + FRAME_IV_LENGTH + kidLength + ephemeralKeyLength;
  if (blob.length < headerLength + FRAME_AUTH_TAG_LENGTH + 1) {
    throw new DecryptionError('Malformed v2 encrypted payload');
  }

  const header = blob.subarray(0, headerLength);
  const kidStart = V2_MAGIC.length + 1 + 1 + 2 + FRAME_IV_LENGTH;
  const kidEnd = kidStart + kidLength;
  const ephemeralKeyStart = kidEnd;
  const ephemeralKeyEnd = ephemeralKeyStart + ephemeralKeyLength;
  const keyId = blob.subarray(kidStart, kidEnd).toString('utf-8');

  if (config.transportV2Key.keyId !== keyId) {
    throw new DecryptionError(`Unknown transport key id: ${keyId}`);
  }

  const ephemeralPublicKeyDer = blob.subarray(ephemeralKeyStart, ephemeralKeyEnd);
  const authTag = blob.subarray(headerLength, headerLength + FRAME_AUTH_TAG_LENGTH);
  const ciphertext = blob.subarray(headerLength + FRAME_AUTH_TAG_LENGTH);

  const ephemeralPublicKey = createPublicKey({
    key: ephemeralPublicKeyDer,
    format: 'der',
    type: 'spki',
  });
  const serverPublicKeyDer = Buffer.from(
    createPublicKey(config.transportV2Key.privateKey).export({
      type: 'spki',
      format: 'der',
    }),
  );
  const contentKey = deriveV2ContentKey(
    diffieHellman({
      privateKey: config.transportV2Key.privateKey,
      publicKey: ephemeralPublicKey,
    }),
    iv,
    Buffer.from(keyId, 'utf-8'),
    ephemeralPublicKeyDer,
    serverPublicKeyDer,
  );

  const decipher = createDecipheriv('aes-256-gcm', contentKey, iv);
  decipher.setAAD(header);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const { metadata, data } = parsePlaintextFrame(plaintext);
  return { metadata, data, transportVersion: 'v2', keyId };
}

function parsePlaintextFrame(plaintext: Buffer): {
  metadata: Record<string, unknown>;
  data?: Buffer;
} {
  if (plaintext.length < 4) {
    throw new DecryptionError('Decrypted payload is too small');
  }

  const metadataLength = plaintext.readUInt32BE(0);
  if (metadataLength > plaintext.length - 4) {
    throw new DecryptionError('Invalid metadata length in decrypted payload');
  }

  const metadataRaw = plaintext.subarray(4, 4 + metadataLength).toString('utf-8');
  const parsed = JSON.parse(metadataRaw) as unknown;
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new DecryptionError('Decrypted metadata is not a valid object');
  }

  const data = plaintext.subarray(4 + metadataLength);
  return {
    metadata: parsed as Record<string, unknown>,
    data: data.length > 0 ? data : undefined,
  };
}

function isV2Envelope(blob: Buffer): boolean {
  return blob.length > V2_MAGIC.length && blob.subarray(0, V2_MAGIC.length).equals(V2_MAGIC);
}

function deriveV2ContentKey(
  sharedSecret: Buffer,
  iv: Buffer,
  kidBytes: Buffer,
  ephemeralPublicKeyDer: Buffer,
  serverPublicKeyDer: Buffer,
): Buffer {
  const info = Buffer.concat([
    Buffer.from('relay-transport-v2', 'utf-8'),
    Buffer.from([0]),
    kidBytes,
    Buffer.from([0]),
    ephemeralPublicKeyDer,
    Buffer.from([0]),
    serverPublicKeyDer,
  ]);
  return Buffer.from(hkdfSync('sha256', sharedSecret, iv, info, 32));
}
