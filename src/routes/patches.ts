import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../lib/config';
import { IncompleteChunksError, RelayError, SessionNotFoundError } from '../lib/errors';
import type { ChunkRequest, CompleteRequest, StatusResponse } from '../lib/types';
import { decrypt } from '../services/crypto';
import { applyPatch, pushBranch } from '../services/git';
import { RepoManager, withRepoLock } from '../services/repo-manager';
import { SessionStore } from '../services/session-store';

export function createPatchesRouter(
  config: AppConfig,
  sessionStore: SessionStore,
  repoManager: RepoManager,
): Router {
  const router = Router();
  const gitEnv = {
    GIT_AUTHOR_NAME: config.gitAuthorName,
    GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
    GIT_COMMITTER_NAME: config.gitCommitterName,
    GIT_COMMITTER_EMAIL: config.gitCommitterEmail,
  };

  /**
   * POST /api/patches/chunk
   * Receive an encrypted chunk for a session.
   */
  router.post('/chunk', (req: Request, res: Response) => {
    try {
      const body = req.body as ChunkRequest;

      if (!body.sessionId || body.chunkIndex == null || !body.totalChunks || !body.data) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'Missing required fields: sessionId, chunkIndex, totalChunks, data' });
        return;
      }

      if (body.chunkIndex < 0 || body.chunkIndex >= body.totalChunks) {
        res.status(400).json({ error: 'INVALID_INPUT', message: `chunkIndex must be 0..${body.totalChunks - 1}` });
        return;
      }

      const chunkData = Buffer.from(body.data, 'base64');
      const received = sessionStore.storeChunk(body.sessionId, body.chunkIndex, body.totalChunks, chunkData);

      res.json({ success: true, received });
    } catch (err) {
      handleError(res, err);
    }
  });

  /**
   * POST /api/patches/complete
   * Signal that all chunks are uploaded. Triggers async processing.
   */
  router.post('/complete', (req: Request, res: Response) => {
    try {
      const body = req.body as CompleteRequest;

      if (!body.sessionId || !body.repo || !body.branch || !body.iv || !body.authTag) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'Missing required fields: sessionId, repo, branch, iv, authTag' });
        return;
      }

      // Validate repo format: owner/repo
      const repoParts = body.repo.split('/');
      if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        res.status(400).json({ error: 'INVALID_INPUT', message: 'repo must be in format "owner/repo"' });
        return;
      }

      // Check session exists and has all chunks
      const session = sessionStore.getSession(body.sessionId);
      if (session.receivedChunks.size < session.totalChunks) {
        throw new IncompleteChunksError(session.totalChunks, session.receivedChunks.size);
      }

      // Set processing status and return 202 immediately
      sessionStore.setStatus(body.sessionId, 'processing', 'Processing patch');
      res.status(202).json({ success: true, status: 'processing' });

      // Async processing — fire-and-forget with error capture
      const [owner, repo] = repoParts;
      const baseBranch = body.baseBranch || 'main';
      const repoKey = `${owner}/${repo}`;

      processSession(body.sessionId, owner, repo, body.branch, baseBranch, body.iv, body.authTag, repoKey).catch(
        (err) => {
          const message = err instanceof Error ? err.message : String(err);
          sessionStore.setFailed(body.sessionId, message);
        },
      );
    } catch (err) {
      handleError(res, err);
    }
  });

  /**
   * GET /api/patches/status/:sessionId
   * Poll the status of a push session.
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

  /**
   * Async session processing pipeline:
   * reassemble → decrypt → prepare repo → apply patch → push
   */
  async function processSession(
    sessionId: string,
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string,
    ivBase64: string,
    authTagBase64: string,
    repoKey: string,
  ): Promise<void> {
    await withRepoLock(repoKey, async () => {
      // 1. Reassemble chunks
      const encryptedData = sessionStore.reassemble(sessionId);

      // 2. Decrypt
      const iv = Buffer.from(ivBase64, 'base64');
      const authTag = Buffer.from(authTagBase64, 'base64');
      const patchContent = decrypt(encryptedData, config.encryptionKey, iv, authTag);

      // 3. Prepare repo (clone/fetch + checkout)
      const repoPath = await repoManager.getRepo(owner, repo, branch, baseBranch);

      // 4. Apply patch
      await applyPatch(repoPath, patchContent, gitEnv);

      // 5. Push
      const commitSha = await pushBranch(repoPath, branch, gitEnv);
      const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`;

      // 6. Update status
      sessionStore.setStatus(sessionId, 'pushed', `Pushed to ${owner}/${repo}:${branch}`, {
        commitSha,
        commitUrl,
      });
    });
  }

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
