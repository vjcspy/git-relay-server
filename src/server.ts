import express, { type Request, type Response, type NextFunction } from 'express';

import type { AppConfig } from './lib/config';
import { DecryptionError, UnauthorizedError } from './lib/errors';
import { createDataRouter } from './routes/data';
import { createGRRouter } from './routes/gr';
import healthRouter from './routes/health';
import { decryptPayload } from './services/crypto';
import { RepoManager } from './services/repo-manager';
import { SessionStore } from './services/session-store';

/**
 * Create and configure the Express application.
 * Separating app creation from listening enables testability.
 */
export function createApp(config: AppConfig) {
  const app = express();

  // --- Middleware ---

  // Parse JSON with 5MB limit (encrypted payload arrives as base64 in JSON)
  app.use(express.json({ limit: '5mb' }));

  // Request logging
  app.use((req: Request, _res: Response, next: NextFunction) => {
    console.log(`${new Date().toISOString()} ${req.method} ${req.path}`);
    next();
  });

  // --- Services ---

  const sessionStore = new SessionStore(config.sessionTtlMs);
  sessionStore.startCleanup();

  const repoManager = new RepoManager(config);

  // --- Auth middleware for /api/* ---

  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    const apiKey = req.headers['x-server-key'] as string | undefined;
    if (apiKey !== config.apiKey) {
      throw new UnauthorizedError();
    }
    next();
  });

  // Decrypt encrypted request payloads after auth:
  // { gameData: "<base64(iv+authTag+ciphertext)>" } -> req.body metadata + req.binaryData
  app.use('/api', (req: Request, _res: Response, next: NextFunction) => {
    if (req.method === 'GET' || req.method === 'HEAD') {
      next();
      return;
    }

    const gameData = (req.body as { gameData?: unknown } | undefined)?.gameData;
    if (typeof gameData !== 'string' || gameData.length === 0) {
      next();
      return;
    }

    try {
      const { metadata, data } = decryptPayload(gameData, config.encryptionKey);
      req.body = metadata;
      req.binaryData = data;
      next();
    } catch (err) {
      next(
        err instanceof DecryptionError
          ? err
          : new DecryptionError('Failed to decrypt request payload'),
      );
    }
  });

  // --- Routes ---

  app.use('/', healthRouter);
  app.use('/api/data', createDataRouter(config, sessionStore));
  app.use('/api/gr', createGRRouter(config, sessionStore, repoManager));

  // --- Global error handler ---

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    if (err instanceof DecryptionError) {
      res.status(400).json({ error: err.code, message: err.message });
      return;
    }
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });

  return { app, sessionStore };
}
