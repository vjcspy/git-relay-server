import { createDecipheriv } from 'node:crypto';

import { DecryptionError } from '../lib/errors';

export interface DecryptedPayload {
  metadata: Record<string, unknown>;
  data?: Buffer;
}

/**
 * Decrypt an encrypted gameData blob and parse:
 * [4B metadataLen][metadata JSON][optional raw binary data]
 *
 * @param gameData - base64(iv + authTag + ciphertext)
 * @param key - 32-byte AES-256 key
 * @returns Decrypted metadata + optional binary payload
 * @throws DecryptionError if decryption or integrity check fails
 */
export function decryptPayload(gameData: string, key: Buffer): DecryptedPayload {
  if (key.length !== 32) {
    throw new DecryptionError(
      `Invalid encryption key length: expected 32 bytes, got ${key.length}`,
    );
  }

  try {
    const blob = Buffer.from(gameData, 'base64');
    if (blob.length < 32) {
      throw new DecryptionError('Encrypted payload is too small');
    }

    const iv = blob.subarray(0, 12);
    const authTag = blob.subarray(12, 28);
    const ciphertext = blob.subarray(28);

    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);

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
