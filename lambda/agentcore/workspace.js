// Workspace git operations for init-ws. Clones the intent's repos into the
// session-persistent filesystem (AgentCore keeps the same microVM for a session,
// so this checkout survives across stage invocations).
//
// Safety: argv-based spawn (shell:false). Credentials are supplied through a
// temporary GIT_ASKPASS environment, never argv or the remote URL. Multi-repo lays out under
// <workspaceDir>/<owner>/<repo>; single-repo clones into <workspaceDir> directly.

import { spawn } from 'node:child_process';
import { mkdir, stat, readdir, rm, symlink, lstat, readFile } from 'node:fs/promises';
import path from 'node:path';
import { buildCloneUrl } from '../shared/git-providers.js';
import { withGitCredential as defaultWithGitCredential } from './git-auth.js';

// Provider-aware clone-URL builder — the single source of truth for the per-
// provider auth scheme (GitHub `x-access-token:`, GitLab `oauth2:`) and host.
// Reusing it keeps the checkout on the shared registry rather than
// re-deriving the GitHub-only scheme here. Defaults to github for legacy/blank.
const run = (command, args, { cwd, env = {}, spawnFn = spawn } = {}) =>
  new Promise((resolve) => {
    const child = spawnFn(command, args, {
      cwd,
      shell: false,
      env: { ...process.env, ...env },
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', () => resolve({ code: null }));
    child.on('close', (code) => resolve({ code }));
  });

const cloneUrl = (repo, gitProvider) => buildCloneUrl(gitProvider, repo, '');

// Clone one repo and check out (creating if needed) the working branch off the
// base branch. `runner`/`ensureDir`
// injectable for tests. The origin remote is left TOKEN-FREE in both outcomes.
//
// IDEMPOTENT for a warm session: a rewind/retry relaunch reuses the intent's
// runtimeSessionId, so the managed mount still holds the previous checkout.
// `git clone` refuses a non-empty directory, which used to make init-ws report
// checkout_failed for a healthy warm-session tree.
// An existing checkout is REUSED: remote re-scrubbed, branch ensured, no
// network. The engine pushed after every prior stage, so the tree is the
// intent branch's durable state — exactly what a rewound run must resume from.
export const checkoutRepo = async ({
  repo,
  branch,
  // null (the common case) = branch off whatever HEAD the clone lands on —
  // the repo's ACTUAL default branch. Never assume 'main': a repo whose
  // default is 'master'/'develop'/… must still get a correct base.
  baseBranch = null,
  gitProvider,
  projectId,
  executionId,
  targetDir,
  runner = run,
  withGitCredential = defaultWithGitCredential,
  ensureDir = (d) => mkdir(d, { recursive: true }),
  statFn = stat,
  removeDir = (d) => rm(d, { recursive: true, force: true }),
  readGitConfig = (d) => readFile(path.join(d, '.git', 'config'), 'utf8'),
}) => {
  await ensureDir(targetDir);
  const cleanUrl = cloneUrl(repo, gitProvider);
  const scrubRemote = async () => {
    const setUrl = await runner('git', ['remote', 'set-url', 'origin', cleanUrl], {
      cwd: targetDir,
    });
    if (setUrl.code !== 0) {
      await runner('git', ['remote', 'add', 'origin', cleanUrl], { cwd: targetDir });
    }
    // A stale pushurl (from a pre-migration tokenized checkout) overrides the
    // scrubbed fetch URL. Remove it if present.
    try {
      const config = await readGitConfig(targetDir);
      if (/^\s*pushurl\s*=/im.test(config)) {
        await runner('git', ['config', '--unset-all', 'remote.origin.pushurl'], {
          cwd: targetDir,
        });
      }
    } catch {
      // Test doubles and partially initialized paths may not expose a config.
      // Clone failures are handled below and never become reusable checkouts.
    }
  };
  // Ensure the working branch exists and is checked out. Rungs:
  //   1. `git checkout <branch>`                    — already exists (warm session).
  //   2a. `git checkout -b <branch>`                 — no base requested: branch off
  //       the clone's current HEAD (the repo's real default).
  //   2b. `git checkout -b <branch> origin/<base>`   — an explicit base: MUST resolve
  //       via the remote-tracking ref. After a normal `git clone`, only the
  //       DEFAULT branch gets a local ref — every other branch exists solely as
  //       `refs/remotes/origin/<name>`. Plain `<base>` as the start-point does NOT
  //       get git's "single remote match" DWIM (that shorthand only applies to the
  //       bare `git checkout <branch>` form, not the `-b <new> <start-point>`
  //       form) — so a non-default base silently failed here and fell through to
  //       the orphan rung, landing every stage's commits on a HISTORY-LESS branch
  //       that quietly diverged from the intended base (field bug).
  //   2c. `git checkout -b <branch> <base>`          — plain-name fallback for a
  //       caller that already holds a LOCAL ref for <base> (e.g. a unit lane
  //       branching off the intent branch that a prior checkout already created
  //       locally in this same workspace — no `origin/` prefix needed there).
  //   3. `git checkout --orphan <branch>`            — ONLY for a genuinely EMPTY
  //       repo (unborn HEAD, verified via `rev-parse --verify HEAD`): gives the
  //       run a real branch so the first stage's commit lands on the intent
  //       branch (field incident: greenfield repo with zero commits silently kept
  //       the run on the default unborn branch). Gated on the empty-repo check so
  //       a typo'd/deleted base branch fails LOUDLY (branch_setup_failed) instead
  //       of silently orphaning a repo that actually has history.
  // Returns true when one rung landed on <branch>; false is a REAL failure the
  // caller must surface (the run would otherwise commit to the wrong branch).
  const ensureBranch = async () => {
    if (!branch) return true;
    const checkout = await runner('git', ['checkout', branch], { cwd: targetDir });
    if (checkout.code === 0) return true;

    if (!baseBranch) {
      const createFromHead = await runner('git', ['checkout', '-b', branch], { cwd: targetDir });
      if (createFromHead.code === 0) return true;
    } else {
      const createFromOrigin = await runner(
        'git',
        ['checkout', '-b', branch, `origin/${baseBranch}`],
        { cwd: targetDir },
      );
      if (createFromOrigin.code === 0) return true;
      const createFromLocal = await runner('git', ['checkout', '-b', branch, baseBranch], {
        cwd: targetDir,
      });
      if (createFromLocal.code === 0) return true;
    }

    const headCheck = await runner('git', ['rev-parse', '--verify', 'HEAD'], { cwd: targetDir });
    if (headCheck.code !== 0) {
      const orphan = await runner('git', ['checkout', '--orphan', branch], { cwd: targetDir });
      return orphan.code === 0;
    }
    return false;
  };

  if (await hasCheckout(targetDir, statFn)) {
    await scrubRemote();
    const branchOk = await ensureBranch();
    return { repo, targetDir, cloned: true, reused: true, branchOk };
  }

  let clone;
  try {
    clone = await withGitCredential(
      {
        executionId,
        projectId,
        provider: gitProvider,
        repository: repo,
        requiredAccess: 'read',
      },
      ({ env }) => runner('git', ['clone', cleanUrl, targetDir], { env }),
    );
  } catch (error) {
    clone = { code: null, error: error.code || 'credential_unavailable' };
  }
  const cloned = clone.code === 0;
  if (!cloned) {
    console.error('[workspace] clone failed', {
      provider: gitProvider,
      reason: clone.error || 'clone_failed',
    });
    // Empty remote repositories clone successfully. Any clone failure is a
    // real authentication/authorization/repository error; remove partial git
    // state so it can never be mistaken for a reusable checkout.
    await removeDir(targetDir).catch(() => {});
    return {
      repo,
      targetDir,
      cloned: false,
      branchOk: false,
      error: clone.error || 'clone_failed',
    };
  }
  // Defense in depth: origin was cloned from this same clean URL, but re-stamp
  // it before the agent can inspect the checkout.
  await scrubRemote();
  const branchOk = await ensureBranch();
  return { repo, targetDir, cloned, branchOk };
};

// The on-disk target dir for a repo, given the intent's repo count. Single-repo
// clones straight into <workspaceDir>; multi lays out under <workspaceDir>/<url>.
// The single source of truth for the layout so init and self-heal agree.
const repoTargetDir = ({ url, workspaceDir, multi }) =>
  multi ? path.join(workspaceDir, url) : workspaceDir;

// Per-repo base-branch override wins; the legacy single string is the
// project-wide fallback; a repo absent from both resolves to null, which
// checkoutRepo treats as "branch off this repo's own default HEAD" — never a
// hardcoded 'main'.
const resolveBaseBranch = (url, baseBranch, baseBranches) =>
  baseBranches?.[url] ?? baseBranch ?? null;

// Check out every repo for the intent into the session workspace.
export const checkoutRepos = async ({
  repos = [],
  branch,
  baseBranch,
  baseBranches,
  gitProvider,
  repoProviders = null,
  projectId,
  executionId,
  workspaceDir,
  runner = run,
  withGitCredential,
  ensureDir,
}) => {
  const out = [];
  const multi = repos.length > 1;
  for (const repo of repos) {
    const url = typeof repo === 'string' ? repo : repo.url;
    const provider =
      (typeof repo === 'object' && repo?.provider) ||
      repoProviders?.[url] ||
      gitProvider ||
      'github';
    const targetDir = repoTargetDir({ url, workspaceDir, multi });
    out.push(
      await checkoutRepo({
        repo: url,
        branch,
        baseBranch: resolveBaseBranch(url, baseBranch, baseBranches),
        gitProvider: provider,
        projectId,
        executionId,
        targetDir,
        runner,
        withGitCredential,
        ensureDir,
      }),
    );
  }
  return out;
};

// A repo's checkout is present when its target dir has a `.git` (clone) — an
// checkout. Absent dir / no `.git` means the mount was wiped.
const hasCheckout = async (targetDir, statFn) => {
  try {
    const s = await statFn(path.join(targetDir, '.git'));
    return s.isDirectory() || s.isFile(); // .git is a dir normally; a file for worktrees/submodules
  } catch {
    return false;
  }
};

// ── node_modules off-mount redirect (2026-07 ENOSPC incident #2) ─────────────
// The 1 GiB session mount's REAL constraint is its write/backup pipeline, not
// used bytes: a single `npm install` (~30-60k files) makes writes fail with
// "Write failed: waiting to be backed up." / ENOSPC while `df` still reports
// 0% used — so a statfs preflight cannot see it coming, and redirecting only
// the package-manager CACHES (the first fix) was not enough. The cure is to
// keep `node_modules` off the mount entirely: before every CLI run the engine
// pre-creates `node_modules` SYMLINKS (one per package.json directory)
// pointing at container-local /tmp. Installs then write through the link onto
// ephemeral disk; the durable working tree stays on the mount.
//
// Properties:
//   - IDEMPOTENT: an existing symlink is kept (its target re-mkdir'd, which
//     also HEALS a dangling link after a container swap — /tmp is per-microVM;
//     npm simply reinstalls into the fresh empty target when needed).
//   - a REAL node_modules directory (pre-fix session, or an agent that
//     deleted the link and reinstalled) is REPLACED by a link — a re-install
//     costs minutes; a choked mount loses work.
//   - the symlink itself is kept out of the user's history via the engine's
//     repo-local runtime excludes (git-engine.js RUNTIME_EXCLUDES).
//   - best-effort per directory: one failed link never blocks the stage (the
//     engine's ENOSPC commit self-heal remains the backstop).
const HEAVY_DIR = 'node_modules';
const WALK_SKIP = new Set([
  '.git',
  'node_modules',
  '.aidlc',
  '.kiro',
  '.claude',
  '.kiro-data',
  '.opencode-data',
  'dist',
  'build',
  'coverage',
  '.next',
]);

export const redirectHeavyDirs = async ({
  workspaceDir,
  offMountRoot = '/tmp/aidlc-node-modules',
  maxDepth = 5,
  maxPackages = 50,
  fsOps = { mkdir, readdir, rm, symlink, lstat },
  log = (...a) => console.error('[workspace]', ...a),
}) => {
  // Find every directory holding a package.json (each is an install root).
  const pkgDirs = [];
  const walk = async (dir, depth) => {
    if (depth > maxDepth || pkgDirs.length >= maxPackages) return;
    let entries;
    try {
      entries = await fsOps.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === 'package.json')) pkgDirs.push(dir);
    for (const e of entries) {
      if (!e.isDirectory() || WALK_SKIP.has(e.name)) continue;
      await walk(path.join(dir, e.name), depth + 1);
    }
  };
  await walk(workspaceDir, 0);

  const links = [];
  for (const dir of pkgDirs) {
    const linkPath = path.join(dir, HEAVY_DIR);
    const rel = path.relative(workspaceDir, dir);
    const target = path.join(
      offMountRoot,
      rel === '' ? 'root' : rel.split(path.sep).join('__'),
      HEAVY_DIR,
    );
    try {
      // Always ensure the target exists — this is also the dangling-link heal.
      await fsOps.mkdir(target, { recursive: true });
      let existing = null;
      try {
        existing = await fsOps.lstat(linkPath);
      } catch {
        /* absent */
      }
      if (existing?.isSymbolicLink()) {
        links.push({ dir, target, action: 'kept' });
        continue;
      }
      if (existing) await fsOps.rm(linkPath, { recursive: true, force: true });
      await fsOps.symlink(target, linkPath, 'dir');
      links.push({ dir, target, action: existing ? 'replaced' : 'created' });
    } catch (e) {
      log(`node_modules redirect failed for ${dir}: ${e?.message}`);
      links.push({ dir, target, action: 'failed', detail: e?.message });
    }
  }
  return { links };
};

// Self-heal the source checkout. AgentCore managed session storage (/mnt/workspace)
// EXPIRES after 14 idle days, and a NEW session (fresh runtimeSessionId, or one
// whose storage expired) starts with an empty mount — a stage that runs on a
// fresh mount would otherwise spawn its CLI against an EMPTY tree and run blind
// (the reverse-engineering "source not present" incident). NOTE (field-proven):
// an image redeploy does NOT wipe the mount of a LIVE session — the session
// keeps its microVM (old image + mount) until stopped or idle-reaped; the mount
// is re-attached by session id across StopRuntimeSession. Called before every
// run-stage (fresh AND resume): re-clone any repo whose checkout is missing.
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
  baseBranches,
  gitProvider,
  repoProviders = null,
  projectId,
  executionId,
  workspaceDir,
  runner = run,
  withGitCredential,
  ensureDir,
  statFn = stat,
}) => {
  const multi = repos.length > 1;
  const restoredRepos = [];
  const failed = [];
  for (const repo of repos) {
    const url = typeof repo === 'string' ? repo : repo.url;
    const provider =
      (typeof repo === 'object' && repo?.provider) ||
      repoProviders?.[url] ||
      gitProvider ||
      'github';
    const targetDir = repoTargetDir({ url, workspaceDir, multi });
    if (await hasCheckout(targetDir, statFn)) continue;
    // Missing: re-clone this one. A failure leaves no reusable `.git` state.
    const res = await checkoutRepo({
      repo: url,
      branch,
      baseBranch: resolveBaseBranch(url, baseBranch, baseBranches),
      gitProvider: provider,
      projectId,
      executionId,
      targetDir,
      runner,
      withGitCredential,
      ensureDir,
    });
    restoredRepos.push(url);
    if (!res.cloned || res.branchOk === false) failed.push(url);
  }
  return { restored: restoredRepos.length > 0, repos: restoredRepos, failed };
};
