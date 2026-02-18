import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../lib/config';
import { RelayError, SessionNotFoundError } from '../lib/errors';
import type { ChunkRequest, CompleteRequest, StatusResponse } from '../lib/types';
import { SessionStore } from '../services/session-store';

export function createDataRouter(
  _config: AppConfig,
  sessionStore: SessionStore,
): Router {
  const router = Router();

  /**
   * POST /api/data/chunk
   * Receive a chunk for a session (metadata in req.body, raw data in req.binaryData).
   */
  router.post('/chunk', (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<ChunkRequest>;

      if (
        !body.sessionId ||
        body.chunkIndex == null ||
        body.totalChunks == null
      ) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required fields: sessionId, chunkIndex, totalChunks',
        });
        return;
      }

      if (!Number.isInteger(body.chunkIndex) || !Number.isInteger(body.totalChunks)) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'chunkIndex and totalChunks must be integers',
        });
        return;
      }

      if (body.totalChunks <= 0) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'totalChunks must be greater than 0',
        });
        return;
      }

      if (body.chunkIndex < 0 || body.chunkIndex >= body.totalChunks) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: `chunkIndex must be 0..${body.totalChunks - 1}`,
        });
        return;
      }

      if (!req.binaryData || req.binaryData.length === 0) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing chunk binary data in encrypted payload',
        });
        return;
      }

      const received = sessionStore.storeChunk(
        body.sessionId,
        body.chunkIndex,
        body.totalChunks,
        req.binaryData,
      );

      res.json({ success: true, received });
    } catch (err) {
      handleError(res, err);
    }
  });

  /**
   * POST /api/data/complete
   * Mark upload complete after all chunks arrive.
   */
  router.post('/complete', (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<CompleteRequest>;
      if (!body.sessionId) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required field: sessionId',
        });
        return;
      }

      sessionStore.markComplete(body.sessionId);
      res.status(202).json({ success: true, status: 'complete' });
    } catch (err) {
      handleError(res, err);
    }
  });

  /**
   * GET /api/data/status/:sessionId
   * Poll the status of an upload session.
   */
  router.get('/status/:sessionId', (req: Request, res: Response) => {
    try {
      const sessionId = req.params.sessionId as string;
      const session = sessionStore.getSession(sessionId);

      const response: StatusResponse = {
        sessionId: session.sessionId,
        status: session.status,
        message: session.message,
        details: {
          chunksReceived: session.receivedChunks.size,
          totalChunks: session.totalChunks,
          ...(session.details as Record<string, unknown>),
        },
      };

      res.json(response);
    } catch (err) {
      handleError(res, err);
    }
  });

  return router;
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
