import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../lib/config';
import { RelayError, SessionNotFoundError } from '../lib/errors';
import type { FileStoreRequest } from '../lib/types';
import { FileStoreService } from '../services/file-store';
import { SessionStore } from '../services/session-store';

export function createFileRouter(
  config: AppConfig,
  sessionStore: SessionStore,
): Router {
  const router = Router();
  const fileStoreService = new FileStoreService(config);

  /**
   * POST /api/file/store
   * Trigger file finalize + store for a completed upload session.
   * Validates input, starts async processing, returns 202 immediately.
   */
  router.post('/store', (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<FileStoreRequest>;

      if (!body.sessionId || !body.fileName || !body.size || !body.sha256) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required fields: sessionId, fileName, size, sha256',
        });
        return;
      }

      if (typeof body.size !== 'number' || body.size <= 0) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'size must be a positive number',
        });
        return;
      }

      if (body.size > config.maxFileSizeBytes) {
        res.status(400).json({
          error: 'FILE_TOO_LARGE',
          message: `File size ${body.size} exceeds max ${config.maxFileSizeBytes} bytes`,
        });
        return;
      }

      if (typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.sha256)) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'sha256 must be a valid 64-character hex string',
        });
        return;
      }

      const started = sessionStore.startProcessing(body.sessionId, 'Processing file');
      if (!started) {
        res.status(202).json({ success: true, status: 'processing' });
        return;
      }

      res.status(202).json({ success: true, status: 'processing' });

      // Async file processing
      processFileStore(
        fileStoreService,
        sessionStore,
        body.sessionId,
        body.fileName,
        body.size,
        body.sha256,
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sessionStore.setFailed(body.sessionId!, message);
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
}

/** Async file store processing */
async function processFileStore(
  fileStoreService: FileStoreService,
  sessionStore: SessionStore,
  sessionId: string,
  fileName: string,
  size: number,
  sha256: string,
): Promise<void> {
  const result = await fileStoreService.storeFile(
    sessionId,
    fileName,
    size,
    sha256,
    sessionStore,
  );

  sessionStore.setStatus(sessionId, 'stored', 'Stored file', {
    storedPath: result.storedPath,
    storedSize: result.storedSize,
  });
}

/** Map RelayError to HTTP response, fallback to 500 */
function handleError(res: Response, err: unknown): void {
  if (err instanceof RelayError) {
    res.status(err.statusCode).json({ error: err.code, message: err.message });
    return;
  }
  if (err instanceof SessionNotFoundError) {
    res.status(404).json({ error: err.code, message: err.message });
    return;
  }
  const message = err instanceof Error ? err.message : String(err);
  console.error('Unhandled error:', message);
  res.status(500).json({ error: 'INTERNAL_ERROR', message });
}
