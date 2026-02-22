import { Router, type Request, type Response } from 'express';

import type { AppConfig } from '../lib/config';
import { RelayError, SessionNotFoundError } from '../lib/errors';
import type { GRProcessRequest } from '../lib/types';
import { applyBundle, getRemoteInfo } from '../services/git';
import { RepoManager, withRepoLock } from '../services/repo-manager';
import { SessionStore } from '../services/session-store';

export function createGRRouter(
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
   * GET /api/gr/remote-info
   * Get the latest commit SHA for a remote branch.
   */
  router.get('/remote-info', async (req: Request, res: Response) => {
    try {
      const repo = req.query.repo as string;
      const branch = req.query.branch as string;

      if (!repo || !branch) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required query params: repo, branch',
        });
        return;
      }

      const repoParts = repo.split('/');
      if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'repo must be in format "owner/repo"',
        });
        return;
      }

      const remoteUrl = `https://x-access-token:${config.githubPat}@github.com/${repo}.git`;
      const sha = await getRemoteInfo(remoteUrl, branch, gitEnv);

      res.status(200).json({ sha });
    } catch (err) {
      handleError(res, err);
    }
  });

  /**
   * POST /api/gr/process
   * Trigger Git Relay processing for a complete upload session.
   */
  router.post('/process', (req: Request, res: Response) => {
    try {
      const body = req.body as Partial<GRProcessRequest>;

      if (!body.sessionId || !body.repo || !body.branch || !body.baseBranch) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'Missing required fields: sessionId, repo, branch, baseBranch',
        });
        return;
      }

      // Validate repo format: owner/repo
      const repoParts = body.repo.split('/');
      if (repoParts.length !== 2 || !repoParts[0] || !repoParts[1]) {
        res.status(400).json({
          error: 'INVALID_INPUT',
          message: 'repo must be in format "owner/repo"',
        });
        return;
      }

      const started = sessionStore.startProcessing(body.sessionId);
      if (!started) {
        res.status(202).json({ success: true, status: 'processing' });
        return;
      }

      res.status(202).json({ success: true, status: 'processing' });

      const [owner, repo] = repoParts;
      const repoKey = `${owner}/${repo}`;
      processSession(
        body.sessionId,
        owner,
        repo,
        body.branch,
        body.baseBranch,
        repoKey,
      ).catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        sessionStore.setFailed(body.sessionId!, message);
      });
    } catch (err) {
      handleError(res, err);
    }
  });

  async function processSession(
    sessionId: string,
    owner: string,
    repo: string,
    branch: string,
    baseBranch: string,
    repoKey: string,
  ): Promise<void> {
    await withRepoLock(repoKey, async () => {
      // 1. Reassemble chunks into the raw patch content
      const patchContent = sessionStore.reassemble(sessionId);

      // 2. Prepare repo (clone/fetch + checkout)
      const repoPath = await repoManager.getRepo(owner, repo, branch, baseBranch);

      // 3. Apply bundle and push
      const commitSha = await applyBundle(repoPath, patchContent, branch, sessionId, gitEnv);
      const commitUrl = `https://github.com/${owner}/${repo}/commit/${commitSha}`;

      // 4. Update status
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
