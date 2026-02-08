import * as fs from 'node:fs';
import * as path from 'node:path';

import simpleGit, { type SimpleGit } from 'simple-git';

import type { AppConfig } from '../lib/config';
import { GitOperationError } from '../lib/errors';

/**
 * Per-repo async lock — serialize operations on the same repo.
 * Sessions targeting different repos run fully in parallel.
 */
const repoLocks = new Map<string, Promise<void>>();

export async function withRepoLock<T>(repoKey: string, fn: () => Promise<T>): Promise<T> {
  const prev = repoLocks.get(repoKey) ?? Promise.resolve();
  let resolve: () => void;
  const next = new Promise<void>((r) => { resolve = r; });
  repoLocks.set(repoKey, next);
  await prev;
  try {
    return await fn();
  } finally {
    resolve!();
  }
}

/**
 * Multi-repo lifecycle manager.
 * Clones repos on first encounter, fetches on subsequent uses.
 * Git auth via PAT embedded in URL.
 */
export class RepoManager {
  private readonly reposDir: string;
  private readonly githubPat: string;
  private readonly gitEnv: Record<string, string>;

  constructor(config: AppConfig) {
    this.reposDir = config.reposDir;
    this.githubPat = config.githubPat;
    this.gitEnv = {
      GIT_AUTHOR_NAME: config.gitAuthorName,
      GIT_AUTHOR_EMAIL: config.gitAuthorEmail,
      GIT_COMMITTER_NAME: config.gitCommitterName,
      GIT_COMMITTER_EMAIL: config.gitCommitterEmail,
    };
  }

  /**
   * Get a repo ready for patching.
   * Clones if not exists, fetches otherwise.
   * Checks out a clean branch based on baseBranch.
   *
   * @param owner - GitHub owner
   * @param repo - GitHub repo name
   * @param branch - Target branch to create/reset
   * @param baseBranch - Remote base branch to branch from
   * @returns Path to the repo working directory
   */
  async getRepo(owner: string, repo: string, branch: string, baseBranch: string): Promise<string> {
    const repoPath = path.join(this.reposDir, owner, repo);
    const repoUrl = `https://x-access-token:${this.githubPat}@github.com/${owner}/${repo}.git`;

    try {
      if (!fs.existsSync(path.join(repoPath, '.git'))) {
        // First time — clone (directory doesn't exist yet, use parent)
        fs.mkdirSync(path.join(this.reposDir, owner), { recursive: true });
        const parentGit = this.createGit(path.join(this.reposDir, owner));
        await parentGit.clone(repoUrl, repo);
      } else {
        // Existing repo — fetch latest
        const git = this.createGit(repoPath);
        await git.fetch('origin');
      }

      // Now repo exists — checkout target branch based on remote base branch
      const git = this.createGit(repoPath);
      await git.checkout(['-B', branch, `origin/${baseBranch}`]);

      return repoPath;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      throw new GitOperationError('prepare-repo', message);
    }
  }

  /** Create a simple-git instance with git identity env vars */
  private createGit(cwd: string): SimpleGit {
    return simpleGit(cwd).env(this.gitEnv);
  }
}
