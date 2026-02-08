import * as fs from 'node:fs';
import * as path from 'node:path';

import { IncompleteChunksError, SessionCompletedError, SessionNotFoundError } from '../lib/errors';
import type { SessionInfo, SessionStatus } from '../lib/types';

const SESSIONS_DIR = '/tmp/relay-sessions';

/**
 * In-memory + filesystem session store.
 * Metadata kept in Map, chunk data written to disk.
 * TTL cleanup runs periodically to remove stale sessions.
 */
export class SessionStore {
  private sessions = new Map<string, SessionInfo>();
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly ttlMs: number) {}

  /** Start periodic cleanup of expired sessions */
  startCleanup(): void {
    // Run cleanup every minute
    this.cleanupTimer = setInterval(() => this.cleanup(), 60_000);
    this.cleanupTimer.unref(); // Don't prevent process exit
  }

  /** Stop periodic cleanup */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Store a chunk for a session. Creates session if first chunk.
   * Idempotent: same (sessionId, chunkIndex) overwrites.
   */
  storeChunk(
    sessionId: string,
    chunkIndex: number,
    totalChunks: number,
    data: Buffer,
  ): number {
    let session = this.sessions.get(sessionId);

    if (session && (session.status === 'processing' || session.status === 'pushed' || session.status === 'failed')) {
      throw new SessionCompletedError(sessionId);
    }

    if (!session) {
      session = {
        sessionId,
        totalChunks,
        receivedChunks: new Set(),
        status: 'receiving',
        message: 'Receiving chunks',
        details: {},
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      this.sessions.set(sessionId, session);
    }

    // Write chunk to disk
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    fs.mkdirSync(sessionDir, { recursive: true });
    const chunkPath = path.join(sessionDir, `chunk-${chunkIndex}.bin`);
    fs.writeFileSync(chunkPath, data);

    session.receivedChunks.add(chunkIndex);
    session.updatedAt = Date.now();

    return session.receivedChunks.size;
  }

  /**
   * Reassemble all chunks for a session into a single buffer.
   * Validates all expected chunks are present.
   * Deletes temp files after reassembly.
   */
  reassemble(sessionId: string): Buffer {
    const session = this.getSession(sessionId);

    if (session.receivedChunks.size < session.totalChunks) {
      throw new IncompleteChunksError(session.totalChunks, session.receivedChunks.size);
    }

    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    const chunks: Buffer[] = [];

    for (let i = 0; i < session.totalChunks; i++) {
      const chunkPath = path.join(sessionDir, `chunk-${i}.bin`);
      chunks.push(fs.readFileSync(chunkPath));
    }

    // Cleanup temp files
    this.cleanupSessionDir(sessionId);

    return Buffer.concat(chunks);
  }

  /** Get session info, throws if not found */
  getSession(sessionId: string): SessionInfo {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError(sessionId);
    }
    return session;
  }

  /** Update session status */
  setStatus(sessionId: string, status: SessionStatus, message: string, details?: Record<string, unknown>): void {
    const session = this.getSession(sessionId);
    session.status = status;
    session.message = message;
    session.updatedAt = Date.now();
    if (details) {
      session.details = { ...session.details, ...details };
    }
  }

  /** Mark session as failed */
  setFailed(sessionId: string, error: string): void {
    try {
      this.setStatus(sessionId, 'failed', 'Processing failed', { error });
      this.cleanupSessionDir(sessionId);
    } catch {
      // Session may already be cleaned up — ignore
    }
  }

  /** Remove expired sessions */
  private cleanup(): void {
    const now = Date.now();
    for (const [sessionId, session] of this.sessions) {
      if (now - session.updatedAt > this.ttlMs) {
        this.cleanupSessionDir(sessionId);
        this.sessions.delete(sessionId);
      }
    }
  }

  /** Delete session temp directory */
  private cleanupSessionDir(sessionId: string): void {
    const sessionDir = path.join(SESSIONS_DIR, sessionId);
    try {
      fs.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}
