// Workspace git operations for init-ws. Clones the intent's repos into the
// session-persistent filesystem (AgentCore keeps the same microVM for a session,
// so this checkout survives across stage invocations).
//
// Safety: argv-based spawn (shell:false) — the token is injected via the URL but
// never interpolated into a shell string. Multi-repo lays out under
// <workspaceDir>/<owner>/<repo>; single-repo clones into <workspaceDir> directly.
//
// Credential scrubbing (docs/v2-parallel.md WP2): the tokenized URL is used for
// the one-shot `git clone` argv only; immediately after, origin is reset to the
// token-FREE URL so `.git/config` never holds a credential at rest. The engine
// (git-engine.js) re-injects the token only inside its own push/fetch window.

import { spawn } from 'node:child_process';
import { mkdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

// Provider-aware clone-URL builder — the single source of truth for the per-
// provider auth scheme (GitHub `x-access-token:`, GitLab `oauth2:`) and host.
// Reusing it keeps the checkout on the shared registry rather than
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
// injectable for tests. The origin remote is left TOKEN-FREE in both outcomes.
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
  const cloned = clone.code === 0;
  if (!cloned) {
    // Empty/new repo (or an unreachable one): initialize so later stages have a
    // working tree. `cloned:false` is surfaced so a self-heal can tell a genuine
    // clone failure apart from a legitimately empty repo.
    await runner('git', ['init', targetDir]);
  }
  // Scrub the credential from the checkout: clone embeds the token in
  // .git/config's origin URL; the git-init fallback has no origin at all.
  // Either way origin ends up as the token-FREE URL (added if missing) so the
  // agent CLI can never read a token; git-engine re-injects it only inside its
  // own push window.
  const cleanUrl = cloneUrl(repo, '', gitProvider);
  const setUrl = await runner('git', ['remote', 'set-url', 'origin', cleanUrl], {
    cwd: targetDir,
  });
  if (setUrl.code !== 0) {
    await runner('git', ['remote', 'add', 'origin', cleanUrl], { cwd: targetDir });
  }
  if (branch) {
    const checkout = await runner('git', ['checkout', branch], { cwd: targetDir });
    if (checkout.code !== 0) {
      await runner('git', ['checkout', '-b', branch, baseBranch], { cwd: targetDir });
    }
  }
  return { repo, targetDir, cloned };
};

// The on-disk target dir for a repo, given the intent's repo count. Single-repo
// clones straight into <workspaceDir>; multi lays out under <workspaceDir>/<url>.
// The single source of truth for the layout so init and self-heal agree.
const repoTargetDir = ({ url, workspaceDir, multi }) =>
  multi ? path.join(workspaceDir, url) : workspaceDir;

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
    const targetDir = repoTargetDir({ url, workspaceDir, multi });
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

// A repo's checkout is present when its target dir has a `.git` (clone) — an
// initialized-empty repo (`git init`, no clone) also has one, so this recognises
// every init-ws outcome. Absent dir / no `.git` → the mount was wiped.
const hasCheckout = async (targetDir, statFn) => {
  try {
    const s = await statFn(path.join(targetDir, '.git'));
    return s.isDirectory() || s.isFile(); // .git is a dir normally; a file for worktrees/submodules
  } catch {
    return false;
  }
};

// Self-heal the source checkout. AgentCore managed session storage (/mnt/workspace)
// is wiped on every runtime image redeploy and after 14 idle days, so a stage that
// runs after a deploy would otherwise spawn its CLI against an EMPTY tree and run
// blind (the reverse-engineering "source not present" incident). Called before
// every run-stage (fresh AND resume): re-clone any repo whose checkout is missing.
//
// `repos: []` (a repo-less project) is a legitimate no-op — nothing to restore.
// Returns { restored, repos, failed }: `restored` is true iff at least one repo
// was re-cloned (so the caller can emit an event and detect that the CLI's own
// conversation store, co-located on the same wiped mount, is also gone); `failed`
// lists repos whose re-clone did not succeed (unreachable/auth) so the caller can
// fail the stage rather than run against an empty tree.
export const ensureWorkspaceSource = async ({
  repos = [],
  branch,
  baseBranch,
  gitToken,
  gitProvider,
  workspaceDir,
  runner = run,
  ensureDir,
  statFn = stat,
}) => {
  const multi = repos.length > 1;
  const restoredRepos = [];
  const failed = [];
  for (const repo of repos) {
    const url = typeof repo === 'string' ? repo : repo.url;
    const targetDir = repoTargetDir({ url, workspaceDir, multi });
    if (await hasCheckout(targetDir, statFn)) continue;
    // Missing — re-clone this one. A failed clone falls back to `git init` (so a
    // `.git` exists either way); `cloned:false` is the signal the source did NOT
    // come down, which for a repo that was clonable at init time means it is now
    // unreachable — the caller treats that as a restore failure.
    const res = await checkoutRepo({
      repo: url,
      branch,
      baseBranch,
      gitToken,
      gitProvider,
      targetDir,
      runner,
      ensureDir,
    });
    restoredRepos.push(url);
    if (!res.cloned) failed.push(url);
  }
  return { restored: restoredRepos.length > 0, repos: restoredRepos, failed };
};
