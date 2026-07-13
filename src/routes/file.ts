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

  router.get('/', (req: Request, res: Response) => {
    try {
      res.json(fileStoreService.listFiles(req.query.limit, req.query.cursor));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/:fileId/manifest', (req: Request, res: Response) => {
    try {
      res.json(fileStoreService.getManifest(req.params.fileId as string));
    } catch (err) {
      handleError(res, err);
    }
  });

  router.get('/:fileId/chunks/:index', (req: Request, res: Response) => {
    try {
      const index = Number(req.params.index);
      const result = fileStoreService.readChunk(req.params.fileId as string, index);
      res.set({
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(result.data.length),
        'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(result.metadata.name)}`,
        'X-File-Id': result.metadata.id,
        'X-Chunk-Index': String(index),
        'X-Total-Chunks': String(result.totalChunks),
      });
      res.send(result.data);
    } catch (err) {
      handleError(res, err);
    }
  });

  /**
   * POST /api/file/store
   * Trigger file finalize + store for a completed upload session.
   * Validates input, starts async processing, returns 202 immediately.
   */
  router.post('/store', async (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<FileStoreRequest>;

      if (!body.sessionId || !body.fileName || body.size == null || !body.sha256) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required fields: sessionId, fileName, size, sha256',
        });
        return;
      }

      if (typeof body.fileName !== 'string' || body.fileName.length > 255) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'fileName must be 1..255 characters' });
        return;
      }

      if (typeof body.size !== 'number' || !Number.isSafeInteger(body.size) || body.size <= 0) {
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

      let started: boolean;
      try {
        started = sessionStore.startProcessing(body.sessionId, 'Processing file');
      } catch (err) {
        if (!(err instanceof SessionNotFoundError)) throw err;
        // A process may have crashed after the atomic data rename but before the
        // metadata commit. The request itself contains everything needed to
        // verify and finish that data-only state without trusting a path.
        const recovered = await fileStoreService.storeFile(
          body.sessionId,
          body.fileName,
          body.size,
          body.sha256,
          sessionStore,
        );
        res.json({ success: true, status: 'stored', fileId: recovered.fileId });
        return;
      }
      if (!started) {
        const session = sessionStore.getSession(body.sessionId);
        res.status(session.status === 'stored' ? 200 : 202).json({ success: true, status: session.status });
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
    fileId: result.fileId,
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
