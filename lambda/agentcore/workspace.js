// Workspace git operations for init-ws. Clones the intent's repos into the
// session-persistent filesystem (AgentCore keeps the same microVM for a session,
// so this checkout survives across stage invocations).
//
// Safety: argv-based spawn (shell:false) — the token is injected via the URL but
// never interpolated into a shell string. Multi-repo lays out under
// <workspaceDir>/<owner>/<repo>; single-repo clones into <workspaceDir> directly.

import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// Provider-aware clone-URL builder — the single source of truth for the per-
// provider auth scheme (GitHub `x-access-token:`, GitLab `oauth2:`) and host.
// Reusing it keeps v2 checkout at parity with the v1 pool-worker rather than
// re-deriving the GitHub-only scheme here. Defaults to github for legacy/blank.
const require = createRequire(import.meta.url);
const { buildCloneUrl } = require('../shared/git-providers.js');

const run = (command, args, { cwd, spawnFn = spawn } = {}) =>
  new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd,
      shell: false,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve({ code: null }));
    child.on('close', (code) => resolve({ code }));
  });

const cloneUrl = (repo, gitToken, gitProvider) => buildCloneUrl(gitProvider, repo, gitToken);

// Clone one repo and check out (creating if needed) the working branch off the
// base branch. Best-effort init for an empty repo. `runner`/`ensureDir`
// injectable for tests.
export const checkoutRepo = async ({
  repo,
  branch,
  baseBranch = 'main',
  gitToken,
  gitProvider,
  targetDir,
  runner = run,
  ensureDir = (d) => mkdir(d, { recursive: true }),
}) => {
  await ensureDir(targetDir);
  const clone = await runner('git', ['clone', cloneUrl(repo, gitToken, gitProvider), targetDir]);
  if (clone.code !== 0) {
    // Empty/new repo: initialize so later stages have a working tree.
    await runner('git', ['init', targetDir]);
  }
  if (branch) {
    const checkout = await runner('git', ['checkout', branch], { cwd: targetDir });
    if (checkout.code !== 0) {
      await runner('git', ['checkout', '-b', branch, baseBranch], { cwd: targetDir });
    }
  }
  return { repo, targetDir };
};

// Check out every repo for the intent into the session workspace.
export const checkoutRepos = async ({
  repos = [],
  branch,
  baseBranch,
  gitToken,
  gitProvider,
  workspaceDir,
  runner = run,
  ensureDir,
}) => {
  const out = [];
  const multi = repos.length > 1;
  for (const repo of repos) {
    const url = typeof repo === 'string' ? repo : repo.url;
    const targetDir = multi ? path.join(workspaceDir, url) : workspaceDir;
    out.push(
      await checkoutRepo({
        repo: url,
        branch,
        baseBranch,
        gitToken,
        gitProvider,
        targetDir,
        runner,
        ensureDir,
      }),
    );
  }
  return out;
};
