import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AppConfig } from '../lib/config';
import { RelayError } from '../lib/errors';
import type { SessionStore } from './session-store';

/** Result of a successful file store operation */
export interface FileStoreResult {
  storedPath: string;
  storedSize: number;
}

/**
 * Service that reassembles uploaded chunks into a durable file,
 * validates size and SHA256 integrity, and persists to long-term storage.
 */
export class FileStoreService {
  constructor(private readonly config: AppConfig) {
    // Ensure storage directory exists at startup
    fs.mkdirSync(this.config.fileStorageDir, { recursive: true });
  }

  /**
   * Reassemble chunks, verify integrity, and store the file durably.
   *
   * Storage layout: <FILE_STORAGE_DIR>/<YYYY>/<MM>/<DD>/<sessionId>-<sanitizedFileName>
   *
   * @throws RelayError on size mismatch, SHA256 mismatch, or write failure
   */
  async storeFile(
    sessionId: string,
    fileName: string,
    expectedSize: number,
    expectedSha256: string,
    sessionStore: SessionStore,
  ): Promise<FileStoreResult> {
    // 1. Reassemble chunks
    const data = sessionStore.reassemble(sessionId);

    // 2. Validate size
    if (data.length !== expectedSize) {
      throw new RelayError(
        'SIZE_MISMATCH',
        `Expected ${expectedSize} bytes, got ${data.length}`,
      );
    }

    if (data.length > this.config.maxFileSizeBytes) {
      throw new RelayError(
        'FILE_TOO_LARGE',
        `File size ${data.length} exceeds max ${this.config.maxFileSizeBytes} bytes`,
      );
    }

    // 3. Compute and verify SHA256
    const actualSha256 = createHash('sha256').update(data).digest('hex');
    if (actualSha256 !== expectedSha256.toLowerCase()) {
      throw new RelayError(
        'SHA256_MISMATCH',
        `Expected SHA256 ${expectedSha256}, got ${actualSha256}`,
      );
    }

    // 4. Build durable storage path
    const sanitized = sanitizeFileName(fileName);
    const now = new Date();
    const dateDir = path.join(
      this.config.fileStorageDir,
      String(now.getFullYear()),
      String(now.getMonth() + 1).padStart(2, '0'),
      String(now.getDate()).padStart(2, '0'),
    );
    fs.mkdirSync(dateDir, { recursive: true });

    const storedName = `${sessionId}-${sanitized}`;
    const storedPath = path.join(dateDir, storedName);

    // Prevent overwriting existing files
    if (fs.existsSync(storedPath)) {
      throw new RelayError(
        'FILE_EXISTS',
        `File already stored at ${storedPath}`,
        409,
      );
    }

    // 5. Write file
    fs.writeFileSync(storedPath, data);

    return { storedPath, storedSize: data.length };
  }
}

/**
 * Sanitize a filename to prevent path traversal and filesystem issues.
 * Keeps only the basename and replaces unsafe characters.
 */
function sanitizeFileName(fileName: string): string {
  // Extract basename (strip directory components)
  let name = path.basename(fileName);

  // Remove control characters and path separators
  name = name.replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_');

  // Collapse multiple underscores
  name = name.replace(/_+/g, '_');

  // Trim leading/trailing underscores and dots (prevent hidden files)
  name = name.replace(/^[_.]+|[_.]+$/g, '');

  // Fallback if name is empty after sanitization
  if (!name) {
    name = 'unnamed';
  }

  return name;
}
