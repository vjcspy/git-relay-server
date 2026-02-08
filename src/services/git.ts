import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import simpleGit from 'simple-git';

import { GitOperationError } from '../lib/errors';

/**
 * Apply a patch using `git am --3way`.
 * Preserves commit message from the patch.
 *
 * @param repoPath - Path to the git repo
 * @param patchContent - Raw patch content (from format-patch)
 * @param gitEnv - Git identity env vars
 */
export async function applyPatch(
  repoPath: string,
  patchContent: Buffer,
  gitEnv: Record<string, string>,
): Promise<void> {
  // Write patch to a temp file (git am reads from file)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'relay-patch-'));
  const patchFile = path.join(tmpDir, 'patch.mbox');
  fs.writeFileSync(patchFile, patchContent);

  const git = simpleGit(repoPath).env(gitEnv);

  try {
    await git.raw(['am', '--3way', '--committer-date-is-author-date', patchFile]);
  } catch (err) {
    // Abort the failed am to leave repo in clean state
    try {
      await git.raw(['am', '--abort']);
    } catch {
      // Abort may fail if there's nothing to abort — ignore
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new GitOperationError('apply-patch', message);
  } finally {
    // Cleanup temp file
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/**
 * Push branch to origin and return the HEAD commit SHA.
 *
 * @param repoPath - Path to the git repo
 * @param branch - Branch to push
 * @param gitEnv - Git identity env vars
 * @returns Commit SHA of HEAD after push
 */
export async function pushBranch(
  repoPath: string,
  branch: string,
  gitEnv: Record<string, string>,
): Promise<string> {
  const git = simpleGit(repoPath).env(gitEnv);

  try {
    await git.push('origin', branch, ['--force-with-lease']);
    const sha = await git.revparse(['HEAD']);
    return sha.trim();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new GitOperationError('push', message);
  }
}
