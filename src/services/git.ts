import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import simpleGit from 'simple-git';

import { GitOperationError } from '../lib/errors';

/**
 * Apply a bundle using `git fetch` into a temp ref and push it directly.
 * Preserves all commit metadata (SHA, author, committer, date, message).
 *
 * @param repoPath - Path to the git repo
 * @param bundleContent - Raw bundle content
 * @param branch - Target branch to push
 * @param sessionId - Session identifier for temp ref
 * @param gitEnv - Git identity env vars
 * @returns Commit SHA of the pushed ref
 */
export async function applyBundle(
  repoPath: string,
  bundleContent: Buffer,
  branch: string,
  sessionId: string,
  gitEnv: Record<string, string>,
): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-bundle-'));
  const bundleFile = path.join(tmpDir, 'relay.bundle');
  fs.writeFileSync(bundleFile, bundleContent);

  const git = simpleGit(repoPath).env(gitEnv);

  try {
    // Verify the bundle
    await git.raw(['bundle', 'verify', bundleFile]);

    // Fetch from bundle into a temporary ref
    const tempRef = `refs/relay/${sessionId}`;
    await git.raw(['fetch', bundleFile, `${branch}:${tempRef}`]);

    // Ensure we have a SHA to return
    const sha = await git.revparse([tempRef]);

    // Push the temporary ref to origin branch
    await git.push('origin', `${tempRef}:refs/heads/${branch}`);

    // Cleanup temp ref
    await git.raw(['update-ref', '-d', tempRef]);

    return sha.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitOperationError('apply-bundle', message);
  } finally {
    // Cleanup temp file
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Get the latest commit SHA for a branch on the remote repository.
 *
 * @param remoteUrl - URL of the remote repository with auth token
 * @param branch - Branch to check
 * @param gitEnv - Git identity env vars
 * @returns Remote commit SHA, or empty string if branch doesn't exist
 */
export async function getRemoteInfo(
  remoteUrl: string,
  branch: string,
  gitEnv: Record<string, string>,
): Promise<string> {
  // Can be run anywhere; we'll use os.tmpdir() to avoid issues
  const git = simpleGit(os.tmpdir()).env(gitEnv);
  try {
    const out = await git.raw(['ls-remote', remoteUrl, `refs/heads/${branch}`]);
    const sha = out.split('\t')[0];
    return sha ? sha.trim() : '';
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitOperationError('ls-remote', message);
  }
}
