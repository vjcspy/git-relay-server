export interface AppConfig {
  port: number;
  apiKey: string;
  encryptionKey: Buffer;
  githubPat: string;
  reposDir: string;
  sessionTtlMs: number;
  gitAuthorName: string;
  gitAuthorEmail: string;
  gitCommitterName: string;
  gitCommitterEmail: string;
}

const REQUIRED_ENV = [
  'API_KEY',
  'ENCRYPTION_KEY',
  'GITHUB_PAT',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
] as const;

/**
 * Validate required env vars are set. Throws on missing vars.
 * Call at startup before any other initialization.
 */
export function validateConfig(): void {
  const missing = REQUIRED_ENV.filter((key) => !process.env[key]);
  if (missing.length > 0) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

/**
 * Load config from environment variables.
 * Must call validateConfig() first.
 */
export function loadConfig(): AppConfig {
  return {
    port: parseInt(process.env.PORT || '3000', 10),
    apiKey: process.env.API_KEY!,
    encryptionKey: Buffer.from(process.env.ENCRYPTION_KEY!, 'base64'),
    githubPat: process.env.GITHUB_PAT!,
    reposDir: process.env.REPOS_DIR || '/data/repos',
    sessionTtlMs: parseInt(process.env.SESSION_TTL_MS || '600000', 10),
    gitAuthorName: process.env.GIT_AUTHOR_NAME || 'relay-bot',
    gitAuthorEmail: process.env.GIT_AUTHOR_EMAIL || 'relay@noreply',
    gitCommitterName: process.env.GIT_COMMITTER_NAME || 'relay-bot',
    gitCommitterEmail: process.env.GIT_COMMITTER_EMAIL || 'relay@noreply',
  };
}
