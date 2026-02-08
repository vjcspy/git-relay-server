import express, { type Request, type Response, type NextFunction } from 'express';

import type { AppConfig } from './lib/config';
import { UnauthorizedError } from './lib/errors';
import healthRouter from './routes/health';
import { createPatchesRouter } from './routes/patches';
import { RepoManager } from './services/repo-manager';
import { SessionStore } from './services/session-store';

/**
 * Create and configure the Express application.
 * Separating app creation from listening enables testability.
 */
export function createApp(config: AppConfig) {
  const app = express();

  // --- Middleware ---

  // Parse JSON with 5MB limit (chunks arrive as base64 in JSON)
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

  // --- Routes ---

  app.use('/', healthRouter);
  app.use('/api/patches', createPatchesRouter(config, sessionStore, repoManager));

  // --- Global error handler ---

  app.use((err: Error, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof UnauthorizedError) {
      res.status(401).json({ error: 'UNAUTHORIZED' });
      return;
    }
    console.error('Unhandled error:', err.message);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  });

  return { app, sessionStore };
}
