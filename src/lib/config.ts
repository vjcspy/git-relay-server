import { createPrivateKey, type KeyObject } from 'node:crypto';

export interface AppConfig {
  port: number;
  apiKey: string;
  encryptionKey?: Buffer;
  transportCryptoMode: TransportCryptoMode;
  transportV2Key?: TransportV2Key;
  transportReplayTtlMs: number;
  transportClockSkewMs: number;
  githubPat: string;
  reposDir: string;
  sessionTtlMs: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  gitCommitterName: string;
  gitCommitterEmail: string;
}

export type TransportCryptoMode = 'v1' | 'compat' | 'v2';

export interface TransportV2Key {
  keyId: string;
  privateKey: KeyObject;
}

const REQUIRED_ENV = [
  'API_KEY',
  'GITHUB_PAT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
] as const;

/**
 * Validate required env vars are set. Throws on missing vars.
 * Call at startup before any other initialization.
 */
export function validateConfig(): void {
  const missing: string[] = REQUIRED_ENV.filter((key) => !process.env[key]);
  const transportCryptoMode = parseTransportCryptoMode(
    process.env.TRANSPORT_CRYPTO_MODE,
  );

  if (transportCryptoMode !== 'v2' && !process.env.ENCRYPTION_KEY) {
    missing.push('ENCRYPTION_KEY');
  }

  if (transportCryptoMode !== 'v1') {
    if (!process.env.TRANSPORT_KEY_ID) {
      missing.push('TRANSPORT_KEY_ID');
    }
    if (!process.env.TRANSPORT_PRIVATE_KEY_PEM) {
      missing.push('TRANSPORT_PRIVATE_KEY_PEM');
    }
  }

  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

/**
 * Load config from environment variables.
 * Must call validateConfig() first.
 */
export function loadConfig(): AppConfig {
  const transportCryptoMode = parseTransportCryptoMode(
    process.env.TRANSPORT_CRYPTO_MODE,
  );
  const encryptionKey = process.env.ENCRYPTION_KEY
    ? Buffer.from(process.env.ENCRYPTION_KEY, 'base64')
    : undefined;
  if (encryptionKey && encryptionKey.length !== 32) {
    throw new Error(
      `Invalid ENCRYPTION_KEY length: expected 32 bytes, got ${encryptionKey.length}`,
    );
  }

  const transportV2Key =
    transportCryptoMode === 'v1'
      ? undefined
      : {
          keyId: process.env.TRANSPORT_KEY_ID!,
          privateKey: createPrivateKey({
            key: normalizeMultilineEnv(process.env.TRANSPORT_PRIVATE_KEY_PEM!),
            format: 'pem',
          }),
        };

  return {
    port: parseInt(process.env.PORT || '3000', 10),
    apiKey: process.env.API_KEY!,
    encryptionKey,
    transportCryptoMode,
    transportV2Key,
    transportReplayTtlMs: parseInt(
      process.env.TRANSPORT_REPLAY_TTL_MS || '300000',
      10,
    ),
    transportClockSkewMs: parseInt(
      process.env.TRANSPORT_CLOCK_SKEW_MS || '30000',
      10,
    ),
    githubPat: process.env.GITHUB_PAT!,
    reposDir: process.env.REPOS_DIR || '/data/repos',
    sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '600000', 10),
    gitAuthorName: process.env.GIT_AUTHOR_NAME || 'relay-bot',
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'relay@noreply',
    gitCommitterName: process.env.GIT_COMMITTER_NAME || 'relay-bot',
    gitCommitterEmail: process.env.GIT_COMMITTER_EMAIL || 'relay@noreply',
  };
}

function parseTransportCryptoMode(value: string | undefined): TransportCryptoMode {
  if (!value || value === 'compat') {
    return 'compat';
  }
  if (value === 'v1' || value === 'v2') {
    return value;
  }
  throw new Error(
    `Invalid TRANSPORT_CRYPTO_MODE: ${value} (expected v1, compat, or v2)`,
  );
}

function normalizeMultilineEnv(value: string): string {
  return value.replace(/\\n/g, '\n');
}
