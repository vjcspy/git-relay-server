import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { once } from 'node:events';
import * as path from 'node:path';

import type { AppConfig } from '../lib/config';
import { RelayError } from '../lib/errors';
import type { StoredFileMetadata } from '../lib/types';
import type { SessionStore } from './session-store';
import { assertCanonicalSessionId } from './session-store';

const DOWNLOAD_CHUNK_SIZE = 3 * 1024 * 1024;
const DEFAULT_PAGE_LIMIT = 20;
const MAX_PAGE_LIMIT = 50;
const MAX_CATALOG_SCAN = 5_000;

export interface FileStoreResult {
  fileId: string;
  storedSize: number;
}

type PublicFileMetadata = Omit<StoredFileMetadata, 'storedFileName'>;

export class FileStoreService {
  private readonly objectsDir: string;
  private readonly metadataDir: string;
  private readonly quarantineDir: string;

  constructor(private readonly config: AppConfig) {
    this.objectsDir = path.join(config.fileStorageDir, 'objects');
    this.metadataDir = path.join(config.fileStorageDir, 'metadata');
    this.quarantineDir = path.join(config.fileStorageDir, 'quarantine');
    for (const directory of [this.objectsDir, this.metadataDir, this.quarantineDir]) {
      fs.mkdirSync(directory, { recursive: true });
    }
  }

  async storeFile(
    sessionId: string,
    fileName: string,
    expectedSize: number,
    expectedSha256: string,
    sessionStore: SessionStore,
  ): Promise<FileStoreResult> {
    assertCanonicalSessionId(sessionId);
    const safeName = sanitizeFileName(fileName);
    const expectedHash = expectedSha256.toLowerCase();
    const dataPath = this.dataPath(sessionId);
    const metadataPath = this.metadataPath(sessionId);

    const state = this.commitState(dataPath, metadataPath);
    if (state === 'metadata-only') {
      this.quarantine(metadataPath, `${sessionId}.metadata-only.json`);
      throw new RelayError('CATALOG_CORRUPTION', 'Stored metadata exists without file data', 500);
    }
    if (state === 'complete') {
      const metadata = this.readValidatedMetadata(metadataPath);
      await this.assertFileIntegrity(dataPath, expectedSize, expectedHash);
      if (metadata.id !== sessionId || metadata.size !== expectedSize || metadata.sha256 !== expectedHash) {
        throw new RelayError('STORE_CONFLICT', 'Existing stored file does not match this upload', 409);
      }
      sessionStore.cleanupSessionFiles(sessionId);
      return { fileId: metadata.id, storedSize: metadata.size };
    }
    if (state === 'data-only') {
      try {
        await this.assertFileIntegrity(dataPath, expectedSize, expectedHash);
      } catch (error) {
        this.quarantine(dataPath, `${sessionId}.invalid-data.bin`);
        throw error;
      }
      const metadata = this.buildMetadata(sessionId, safeName, expectedSize, expectedHash);
      this.writeMetadataAtomically(metadataPath, metadata);
      sessionStore.cleanupSessionFiles(sessionId);
      return { fileId: sessionId, storedSize: expectedSize };
    }

    const temporaryPath = path.join(this.objectsDir, `.${sessionId}.${process.pid}.${Date.now()}.tmp`);
    const output = fs.createWriteStream(temporaryPath, { flags: 'wx' });
    const hash = createHash('sha256');
    let size = 0;
    try {
      for (const chunkPath of sessionStore.getChunkPaths(sessionId)) {
        const input = fs.createReadStream(chunkPath);
        for await (const chunk of input) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          if (size > this.config.maxFileSizeBytes) {
            throw new RelayError('FILE_TOO_LARGE', 'File exceeds configured maximum', 413);
          }
          hash.update(bytes);
          if (!output.write(bytes)) await once(output, 'drain');
        }
      }
      output.end();
      await once(output, 'close');

      const actualHash = hash.digest('hex');
      if (size !== expectedSize) throw new RelayError('SIZE_MISMATCH', `Expected ${expectedSize} bytes, got ${size}`);
      if (actualHash !== expectedHash) throw new RelayError('SHA256_MISMATCH', 'Stored data SHA-256 does not match');

      fs.renameSync(temporaryPath, dataPath);
      const metadata = this.buildMetadata(sessionId, safeName, size, actualHash);
      this.writeMetadataAtomically(metadataPath, metadata);
      sessionStore.cleanupSessionFiles(sessionId);
      return { fileId: sessionId, storedSize: size };
    } catch (error) {
      output.destroy();
      fs.rmSync(temporaryPath, { force: true });
      throw error;
    }
  }

  listFiles(limitValue: unknown, cursorValue: unknown): { files: PublicFileMetadata[]; nextCursor: string | null } {
    const limit = parseLimit(limitValue);
    const cursor = parseCursor(cursorValue);
    const entries = fs.readdirSync(this.metadataDir, { withFileTypes: true });
    if (entries.length > MAX_CATALOG_SCAN) {
      throw new RelayError('CATALOG_LIMIT', 'Catalog is too large for bounded filesystem scanning', 503);
    }

    const files: StoredFileMetadata[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
      try {
        const metadata = this.readValidatedMetadata(path.join(this.metadataDir, entry.name));
        if (!fs.existsSync(this.dataPath(metadata.id))) {
          console.error(`Catalog entry ${metadata.id} has no data file; skipping`);
          continue;
        }
        files.push(metadata);
      } catch (error) {
        console.error(`Invalid catalog entry ${entry.name}; skipping: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    files.sort(compareNewestFirst);
    const afterCursor = cursor
      ? files.filter((file) => comparePosition(file, cursor) > 0)
      : files;
    const page = afterCursor.slice(0, limit);
    const nextCursor = afterCursor.length > limit ? encodeCursor(page[page.length - 1]) : null;
    return { files: page.map(toPublicMetadata), nextCursor };
  }

  getManifest(fileId: string): PublicFileMetadata & { chunkSize: number; totalChunks: number } {
    const metadata = this.resolveMetadata(fileId);
    return {
      ...toPublicMetadata(metadata),
      chunkSize: DOWNLOAD_CHUNK_SIZE,
      totalChunks: Math.ceil(metadata.size / DOWNLOAD_CHUNK_SIZE),
    };
  }

  readChunk(fileId: string, chunkIndex: number): { metadata: StoredFileMetadata; data: Buffer; totalChunks: number } {
    const metadata = this.resolveMetadata(fileId);
    const totalChunks = Math.ceil(metadata.size / DOWNLOAD_CHUNK_SIZE);
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= totalChunks) {
      throw new RelayError('INVALID_CHUNK_INDEX', `chunk index must be 0..${Math.max(totalChunks - 1, 0)}`, 416);
    }
    const length = Math.min(DOWNLOAD_CHUNK_SIZE, metadata.size - chunkIndex * DOWNLOAD_CHUNK_SIZE);
    const data = Buffer.allocUnsafe(length);
    const fd = fs.openSync(this.dataPath(fileId), 'r');
    try {
      const read = fs.readSync(fd, data, 0, length, chunkIndex * DOWNLOAD_CHUNK_SIZE);
      if (read !== length) throw new RelayError('SHORT_READ', 'Stored file ended unexpectedly', 500);
    } finally {
      fs.closeSync(fd);
    }
    return { metadata, data, totalChunks };
  }

  private resolveMetadata(fileId: string): StoredFileMetadata {
    assertCanonicalSessionId(fileId);
    const metadataPath = this.metadataPath(fileId);
    if (!fs.existsSync(metadataPath)) throw new RelayError('FILE_NOT_FOUND', 'File not found', 404);
    const metadata = this.readValidatedMetadata(metadataPath);
    if (!fs.existsSync(this.dataPath(metadata.id))) throw new RelayError('FILE_NOT_FOUND', 'File is unavailable', 404);
    return metadata;
  }

  private buildMetadata(id: string, name: string, size: number, sha256: string): StoredFileMetadata {
    return { version: 1, id, name, size, sha256, storedAt: new Date().toISOString(), storedFileName: `${id}.bin` };
  }

  private readValidatedMetadata(metadataPath: string): StoredFileMetadata {
    const value = JSON.parse(fs.readFileSync(metadataPath, 'utf8')) as Partial<StoredFileMetadata>;
    if (
      value.version !== 1 || typeof value.id !== 'string' || typeof value.name !== 'string' ||
      typeof value.size !== 'number' || !Number.isSafeInteger(value.size) || value.size <= 0 ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      typeof value.storedAt !== 'string' || Number.isNaN(Date.parse(value.storedAt)) ||
      value.storedFileName !== `${value.id}.bin`
    ) throw new RelayError('INVALID_METADATA', 'Invalid stored file metadata', 500);
    assertCanonicalSessionId(value.id);
    return value as StoredFileMetadata;
  }

  private writeMetadataAtomically(metadataPath: string, metadata: StoredFileMetadata): void {
    const temporaryPath = `${metadataPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, `${JSON.stringify(metadata)}\n`, { flag: 'wx' });
    fs.renameSync(temporaryPath, metadataPath);
  }

  private async assertFileIntegrity(filePath: string, expectedSize: number, expectedHash: string): Promise<void> {
    const hash = createHash('sha256');
    let size = 0;
    for await (const chunk of fs.createReadStream(filePath)) {
      const bytes = chunk as Buffer;
      size += bytes.length;
      hash.update(bytes);
    }
    if (size !== expectedSize || hash.digest('hex') !== expectedHash) {
      throw new RelayError('STORE_CONFLICT', 'Recovered data file fails size or SHA-256 validation', 409);
    }
  }

  private commitState(dataPath: string, metadataPath: string): 'neither' | 'data-only' | 'metadata-only' | 'complete' {
    const data = fs.existsSync(dataPath);
    const metadata = fs.existsSync(metadataPath);
    if (data && metadata) return 'complete';
    if (data) return 'data-only';
    if (metadata) return 'metadata-only';
    return 'neither';
  }

  private quarantine(sourcePath: string, name: string): void {
    if (fs.existsSync(sourcePath)) fs.renameSync(sourcePath, path.join(this.quarantineDir, `${Date.now()}-${name}`));
  }

  private dataPath(id: string): string {
    assertCanonicalSessionId(id);
    return path.join(this.objectsDir, `${id}.bin`);
  }

  private metadataPath(id: string): string {
    assertCanonicalSessionId(id);
    return path.join(this.metadataDir, `${id}.json`);
  }
}

function sanitizeFileName(fileName: string): string {
  let name = path.basename(fileName).replace(/[\x00-\x1f\x7f/\\:*?"<>|]/g, '_').replace(/_+/g, '_');
  name = name.replace(/^[_.]+|[_.]+$/g, '');
  return (name || 'unnamed').slice(0, 255);
}

function parseLimit(value: unknown): number {
  if (value == null || value === '') return DEFAULT_PAGE_LIMIT;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1) throw new RelayError('INVALID_LIMIT', 'limit must be a positive integer');
  return Math.min(parsed, MAX_PAGE_LIMIT);
}

interface CursorPosition { storedAt: string; id: string }
function parseCursor(value: unknown): CursorPosition | null {
  if (value == null || value === '') return null;
  if (typeof value !== 'string' || value.length > 512) throw new RelayError('INVALID_CURSOR', 'Invalid cursor');
  try {
    const cursor = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<CursorPosition>;
    if (typeof cursor.storedAt !== 'string' || typeof cursor.id !== 'string' || Number.isNaN(Date.parse(cursor.storedAt))) throw new Error();
    assertCanonicalSessionId(cursor.id);
    return cursor as CursorPosition;
  } catch {
    throw new RelayError('INVALID_CURSOR', 'Invalid cursor');
  }
}
function encodeCursor(file: StoredFileMetadata): string {
  return Buffer.from(JSON.stringify({ storedAt: file.storedAt, id: file.id })).toString('base64url');
}
function compareNewestFirst(a: StoredFileMetadata, b: StoredFileMetadata): number {
  return b.storedAt.localeCompare(a.storedAt) || b.id.localeCompare(a.id);
}
function comparePosition(file: StoredFileMetadata, cursor: CursorPosition): number {
  return cursor.storedAt.localeCompare(file.storedAt) || cursor.id.localeCompare(file.id);
}
function toPublicMetadata(file: StoredFileMetadata): PublicFileMetadata {
  const { storedFileName: _storedFileName, ...publicMetadata } = file;
  return publicMetadata;
}
