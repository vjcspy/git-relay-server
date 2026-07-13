import * as fs from 'node:fs';
import * as path from 'node:path';

import type { AppConfig } from '../lib/config';
import {
  IncompleteChunksError,
  RelayError,
  SessionCompletedError,
  SessionNotFoundError,
} from '../lib/errors';
import type { SessionInfo, SessionStatus } from '../lib/types';

const SESSIONS_DIR = '/tmp/relay-sessions';
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function assertCanonicalSessionId(sessionId: string): void {
  if (!CANONICAL_UUID.test(sessionId)) {
    throw new RelayError('INVALID_SESSION_ID', 'sessionId must be a canonical lowercase UUID');
  }
}

export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly ttlMs: number,
    private readonly limits: Pick<
      AppConfig,
      | 'maxFileSizeBytes'
      | 'maxChunkSizeBytes'
      | 'maxChunksPerSession'
      | 'maxActiveSessions'
      | 'maxTemporaryStorageBytes'
    >,
  ) {
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.cleanupOrphanedSessionDirs();
  }

  startCleanup(): void {
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref();
  }

  stopCleanup(): void {
    if (this.cleanupTimer) clearInterval(this.cleanupTimer);
    this.cleanupTimer = null;
  }

  storeChunk(sessionId: string, chunkIndex: number, totalChunks: number, data: Buffer): number {
    assertCanonicalSessionId(sessionId);
    if (data.length > this.limits.maxChunkSizeBytes) {
      throw new RelayError('CHUNK_TOO_LARGE', `Chunk exceeds ${this.limits.maxChunkSizeBytes} bytes`, 413);
    }
    if (totalChunks > this.limits.maxChunksPerSession) {
      throw new RelayError('TOO_MANY_CHUNKS', `totalChunks exceeds ${this.limits.maxChunksPerSession}`);
    }

    let session = this.sessions.get(sessionId);
    if (session && session.status !== 'receiving') throw new SessionCompletedError(sessionId);
    if (!session) {
      const activeSessions = [...this.sessions.values()].filter(
        (candidate) => candidate.status !== 'stored' && candidate.status !== 'pushed',
      ).length;
      if (activeSessions >= this.limits.maxActiveSessions) {
        throw new RelayError('TOO_MANY_SESSIONS', 'Active upload session limit reached', 429);
      }
      session = {
        sessionId,
        totalChunks,
        receivedChunks: new Set(),
        chunkSizes: new Map(),
        receivedBytes: 0,
        status: 'receiving',
        message: 'Receiving chunks',
        details: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
    } else if (session.totalChunks !== totalChunks) {
      throw new RelayError('CHUNK_COUNT_MISMATCH', 'totalChunks is immutable for an upload session', 409);
    }

    const chunkPath = this.chunkPath(sessionId, chunkIndex);
    const priorSize = session.chunkSizes.get(chunkIndex) ?? 0;
    const priorDiskSize = fs.existsSync(chunkPath) ? fs.statSync(chunkPath).size : 0;
    const nextSessionBytes = session.receivedBytes - priorSize + data.length;
    if (nextSessionBytes > this.limits.maxFileSizeBytes) {
      throw new RelayError('FILE_TOO_LARGE', 'Upload exceeds the per-session byte limit', 413);
    }
    const nextAggregate = this.aggregateBytes() - priorDiskSize + data.length;
    if (nextAggregate > this.limits.maxTemporaryStorageBytes) {
      throw new RelayError('TEMP_STORAGE_LIMIT', 'Temporary upload storage limit reached', 507);
    }

    fs.mkdirSync(path.dirname(chunkPath), { recursive: true });
    const temporaryPath = `${chunkPath}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(temporaryPath, data, { flag: 'wx' });
    fs.renameSync(temporaryPath, chunkPath);

    session.receivedChunks.add(chunkIndex);
    session.chunkSizes.set(chunkIndex, data.length);
    session.receivedBytes = nextSessionBytes;
    session.updatedAt = Date.now();
    return session.receivedChunks.size;
  }

  getSession(sessionId: string): SessionInfo {
    assertCanonicalSessionId(sessionId);
    const session = this.sessions.get(sessionId);
    if (!session) throw new SessionNotFoundError(sessionId);
    return session;
  }

  getChunkPaths(sessionId: string): string[] {
    const session = this.getSession(sessionId);
    if (session.receivedChunks.size !== session.totalChunks) {
      throw new IncompleteChunksError(session.totalChunks, session.receivedChunks.size);
    }
    return Array.from({ length: session.totalChunks }, (_, index) => {
      if (!session.receivedChunks.has(index)) {
        throw new IncompleteChunksError(session.totalChunks, session.receivedChunks.size);
      }
      const chunkPath = this.chunkPath(sessionId, index);
      if (!fs.existsSync(chunkPath)) throw new RelayError('MISSING_CHUNK', `Chunk ${index} is missing`, 409);
      return chunkPath;
    });
  }

  /** Compatibility path for Git bundle processing; file storage uses streaming commit. */
  reassemble(sessionId: string): Buffer {
    const data = Buffer.concat(this.getChunkPaths(sessionId).map((chunkPath) => fs.readFileSync(chunkPath)));
    if (data.length > this.limits.maxFileSizeBytes) {
      throw new RelayError('FILE_TOO_LARGE', 'Reassembled payload exceeds the configured maximum', 413);
    }
    this.cleanupSessionFiles(sessionId);
    return data;
  }

  markComplete(sessionId: string): void {
    const session = this.getSession(sessionId);
    if (session.status !== 'receiving') {
      throw new RelayError('INVALID_STATE', `Session ${sessionId} is ${session.status}, expected receiving`, 409);
    }
    if (session.receivedChunks.size !== session.totalChunks) {
      throw new IncompleteChunksError(session.totalChunks, session.receivedChunks.size);
    }
    this.setStatus(sessionId, 'complete', 'Upload complete');
  }

  startProcessing(sessionId: string, message = 'Processing patch'): boolean {
    const session = this.getSession(sessionId);
    if (session.status === 'processing') return false;
    if (session.status === 'stored') return false;
    if (session.status !== 'complete' && session.status !== 'failed') {
      throw new RelayError('INVALID_STATE', `Session ${sessionId} is ${session.status}, expected complete`, 409);
    }
    this.setStatus(sessionId, 'processing', message);
    return true;
  }

  setStatus(sessionId: string, status: SessionStatus, message: string, details?: Record<string, unknown>): void {
    const session = this.getSession(sessionId);
    session.status = status;
    session.message = message;
    session.updatedAt = Date.now();
    if (details) session.details = { ...session.details, ...details };
  }

  setFailed(sessionId: string, error: string): void {
    try {
      this.setStatus(sessionId, 'failed', 'Processing failed; upload remains retryable', { error });
    } catch {
      // Session may have expired.
    }
  }

  cleanupSession(sessionId: string): void {
    assertCanonicalSessionId(sessionId);
    const sessionDir = this.sessionDir(sessionId);
    fs.rmSync(sessionDir, { recursive: true, force: true });
    this.sessions.delete(sessionId);
  }

  cleanupSessionFiles(sessionId: string): void {
    fs.rmSync(this.sessionDir(sessionId), { recursive: true, force: true });
    const session = this.sessions.get(sessionId);
    if (session) {
      session.receivedBytes = 0;
      session.chunkSizes.clear();
    }
  }

  private aggregateBytes(): number {
    let total = 0;
    for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CANONICAL_UUID.test(entry.name)) continue;
      const sessionDir = this.sessionDir(entry.name);
      for (const chunk of fs.readdirSync(sessionDir, { withFileTypes: true })) {
        if (!chunk.isFile()) continue;
        total += fs.statSync(path.join(sessionDir, chunk.name)).size;
      }
    }
    return total;
  }

  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) this.cleanupSession(sessionId);
    }
    this.cleanupOrphanedSessionDirs(now);
  }

  private cleanupOrphanedSessionDirs(now = Date.now()): void {
    for (const entry of fs.readdirSync(SESSIONS_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory() || !CANONICAL_UUID.test(entry.name) || this.sessions.has(entry.name)) continue;
      const sessionDir = this.sessionDir(entry.name);
      if (now - fs.statSync(sessionDir).mtimeMs > this.ttlMs) {
        fs.rmSync(sessionDir, { recursive: true, force: true });
      }
    }
  }

  private sessionDir(sessionId: string): string {
    assertCanonicalSessionId(sessionId);
    const resolved = path.resolve(SESSIONS_DIR, sessionId);
    if (!resolved.startsWith(`${path.resolve(SESSIONS_DIR)}${path.sep}`)) {
      throw new RelayError('INVALID_SESSION_PATH', 'Session path escapes temporary storage');
    }
    return resolved;
  }

  private chunkPath(sessionId: string, chunkIndex: number): string {
    if (!Number.isInteger(chunkIndex) || chunkIndex < 0 || chunkIndex >= this.limits.maxChunksPerSession) {
      throw new RelayError('INVALID_CHUNK_INDEX', 'Invalid chunk index');
    }
    const resolved = path.resolve(this.sessionDir(sessionId), `chunk-${chunkIndex}.bin`);
    if (!resolved.startsWith(`${this.sessionDir(sessionId)}${path.sep}`)) {
      throw new RelayError('INVALID_CHUNK_PATH', 'Chunk path escapes session storage');
    }
    return resolved;
  }
}
