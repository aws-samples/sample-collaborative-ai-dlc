// git-engine — the engine-owned deterministic git layer (docs/v2-parallel.md WP2).
//
// The agent CLI never commits, pushes, merges, or holds credentials (v1 lost
// code precisely where agents owned commits). Instead, THIS module:
//
//   - commits the whole working tree after every stage exit (success, park,
//     fail) with a deterministic `aidlc(<stage>): …` message,
//   - pushes with v1 pushBranchWithRetry semantics ported from
//     lambda/agents-ecs/pool-worker.js: retry + linear backoff + remote-HEAD
//     verification, `'empty'` as a neutral no-commit sentinel,
//   - owns credentials: the checkout's remote URL is TOKEN-FREE at rest
//     (workspace.js scrubs it after clone); the tokenized URL is injected only
//     for the duration of an engine push and always restored in a finally —
//     the agent CLI can read `.git/config` and find nothing,
//   - skips the network entirely when there is nothing to push (no new commit
//     and the remote-tracking ref already matches HEAD), so artifact-only
//     stages on token-less projects behave exactly as before.
//
// Safety: every git call is argv-based spawn with shell:false — tokens and
// branch names are never interpolated into a shell string.
//
// All functions resolve (never reject): a git failure is a VALUE the caller
// records and acts on. The stage-failure policy lives in run-stage.js: a push
// failure fails the stage only when THIS stage created commits that did not
// reach the remote (new work at risk = the documented v2 loss mode).

import { spawn } from 'node:child_process';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { buildCloneUrl } = require('../shared/git-providers.js');

// Neutral committer identity, passed per-command via `-c` so the repo config
// is never mutated (and the agent can't inherit it for its own commits).
const GIT_IDENTITY = [
  '-c',
  'user.email=aidlc-engine@noreply.local',
  '-c',
  'user.name=AI-DLC Engine',
];

// Ambient GIT_* environment variables redirect git to a DIFFERENT repository
// (GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE) or override the engine identity
// (GIT_AUTHOR_*/GIT_COMMITTER_*). Any process that spawns the engine from
// inside a git hook (or any git-managed context) would leak them in — strip
// them so engine git is deterministic regardless of the caller's environment.
const AMBIENT_GIT_ENV =
  /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|PREFIX|NAMESPACE|CEILING_DIRECTORIES|AUTHOR_|COMMITTER_)/;

const sanitizedGitEnv = () => {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (!AMBIENT_GIT_ENV.test(k)) env[k] = v;
  }
  return env;
};

// argv-based git runner: captures stdout/stderr, resolves { exitCode, stdout,
// stderr }, never rejects (spawn errors → exitCode null). Mirrors
// cli/spawn.js#captureChild but is git-scoped and dependency-free.
export const runGit = (args, { cwd, spawnFn = spawn } = {}) =>
  new Promise((resolve) => {
    let settled = false;
    const settle = (v) => {
      if (!settled) {
        settled = true;
        resolve(v);
      }
    };
    const child = spawnFn('git', args, {
      cwd,
      shell: false,
      env: sanitizedGitEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (c) => {
      stdout += c.toString();
    });
    child.stderr?.on('data', (c) => {
      stderr += c.toString();
    });
    child.on('error', () => settle({ exitCode: null, stdout, stderr }));
    child.on('close', (exitCode) => settle({ exitCode, stdout, stderr }));
  });

// Token-free remote URL — what `.git/config` holds at rest.
export const cleanRemoteUrl = (repo, gitProvider) => buildCloneUrl(gitProvider, repo, '');

// Set origin to the token-free URL (adding the remote if missing — the
// `git init` fallback for empty repos has none). `urls.clean` overrides the
// provider-derived URL (tests use file:// remotes).
export const scrubRemote = async ({ dir, repo, gitProvider, urls = {}, git = runGit }) => {
  const url = urls.clean ?? cleanRemoteUrl(repo, gitProvider);
  const set = await git(['remote', 'set-url', 'origin', url], { cwd: dir });
  if (set.exitCode === 0) return { scrubbed: true };
  const add = await git(['remote', 'add', 'origin', url], { cwd: dir });
  return { scrubbed: add.exitCode === 0 };
};

// Stage + commit everything in the tree. Returns:
//   { committed: true,  sha }             — a new commit was created
//   { committed: false, reason: 'clean' } — nothing to commit (normal for
//                                           stages that only write graph artifacts)
//   { committed: false, reason: 'add_failed' | 'commit_failed', detail }
export const commitAll = async ({ dir, message, git = runGit }) => {
  const add = await git(['add', '-A'], { cwd: dir });
  if (add.exitCode !== 0) {
    return { committed: false, reason: 'add_failed', detail: add.stderr.trim() };
  }
  const status = await git(['status', '--porcelain'], { cwd: dir });
  if (status.exitCode === 0 && status.stdout.trim() === '') {
    return { committed: false, reason: 'clean' };
  }
  const commit = await git([...GIT_IDENTITY, 'commit', '-m', message], { cwd: dir });
  if (commit.exitCode !== 0) {
    return { committed: false, reason: 'commit_failed', detail: commit.stderr.trim() };
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  return { committed: true, sha: head.stdout.trim() || null };
};

// Is there anything HEAD has that the remote-tracking ref does not? Used to
// skip the push (and its network/auth cost) when the tree is clean and the
// last push already landed. A missing remote-tracking ref (new branch, never
// pushed) counts as ahead. No HEAD at all (empty repo) is NOT ahead.
export const isAheadOfRemote = async ({ dir, branch, git = runGit }) => {
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.exitCode !== 0) return false;
  const remoteRef = await git(['rev-parse', '--verify', `refs/remotes/origin/${branch}`], {
    cwd: dir,
  });
  if (remoteRef.exitCode !== 0) return true;
  return remoteRef.stdout.trim() !== head.stdout.trim();
};

// Push HEAD to the branch with v1 pushBranchWithRetry semantics. The tokenized
// remote URL exists ONLY between the set-url and the finally-scrub. Returns:
//   { pushed: 'empty' }               — no commits at all (new/empty repo)
//   { pushed: true, sha, verified }   — on the remote (verified: ls-remote head
//                                       matched; a mismatch/unreadable ls-remote
//                                       still counts as pushed, like v1)
//   { pushed: false, reason, detail } — real failure after retries
export const pushBranch = async ({
  dir,
  repo,
  branch,
  gitToken,
  gitProvider,
  attempts = 3,
  urls = {},
  git = runGit,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (...a) => console.error('[git-engine]', ...a),
}) => {
  if (!branch) return { pushed: false, reason: 'no_branch' };

  // Empty-repo guard (v1: an expected no-op, not an error).
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  if (head.exitCode !== 0) return { pushed: 'empty' };
  const localHead = head.stdout.trim();

  // Inject credentials for the push window only.
  const authUrl = urls.auth ?? buildCloneUrl(gitProvider, repo, gitToken);
  const setAuth = await git(['remote', 'set-url', 'origin', authUrl], { cwd: dir });
  if (setAuth.exitCode !== 0) {
    return { pushed: false, reason: 'remote_set_url_failed', detail: setAuth.stderr.trim() };
  }

  try {
    let lastDetail = '';
    for (let attempt = 1; attempt <= attempts; attempt++) {
      // Push HEAD explicitly to the remote refspec so it works even if the
      // local branch name diverged (v1 semantics).
      const push = await git(['push', 'origin', `HEAD:refs/heads/${branch}`], { cwd: dir });
      if (push.exitCode === 0) {
        // Remote-HEAD verification. A mismatch can be a legitimate race (the
        // remote advanced); an unreadable ls-remote falls back to trusting the
        // push exit code — both still count as pushed (v1 semantics).
        const remote = await git(['ls-remote', 'origin', branch], { cwd: dir });
        if (remote.exitCode === 0) {
          const remoteHead = remote.stdout.trim().split(/\s/)[0] ?? '';
          const verified = remoteHead === localHead;
          if (!verified) {
            log(`push verification mismatch for ${repo}#${branch}:`, { localHead, remoteHead });
          }
          return { pushed: true, sha: localHead, verified };
        }
        log(`ls-remote failed for ${repo}#${branch}; trusting push exit code`);
        return { pushed: true, sha: localHead, verified: false };
      }
      lastDetail = (push.stderr || '').trim().slice(-500);
      log(`push attempt ${attempt}/${attempts} failed for ${repo}#${branch}`);
      if (attempt < attempts) await sleep(attempt * 2000);
    }
    return { pushed: false, reason: 'push_failed', detail: lastDetail };
  } finally {
    // The token must never outlive the push window, even on a crash path.
    await scrubRemote({ dir, repo, gitProvider, urls, git });
  }
};

// The on-disk target dir for a repo — MUST match workspace.js#repoTargetDir
// (single repo → workspaceDir; multi → workspaceDir/<owner>/<repo>).
const repoTargetDir = ({ url, workspaceDir, multi }) =>
  multi ? path.join(workspaceDir, url) : workspaceDir;

// The deterministic stage-exit hook: commit + (when needed) push every repo of
// the intent. One call after EVERY stage exit (success, park, fail). Never
// throws.
//
// Returns { ok, committed, results }:
//   ok        — no repo had a REAL push failure (clean trees, empty repos and
//               up-to-date remotes are neutral, mirroring v1's aggregation)
//   committed — at least one repo got a new commit from THIS call (the caller
//               uses this to decide whether a push failure risks new work)
export const commitAndPushAll = async ({
  repos = [],
  workspaceDir,
  branch,
  gitToken,
  gitProvider,
  message,
  urlsFor = null, // (repoUrl) => { clean, auth } — test seam for file:// remotes
  git = runGit,
  sleep,
  log = (...a) => console.error('[git-engine]', ...a),
}) => {
  const results = [];
  const multi = repos.length > 1;
  for (const repo of repos) {
    const url = typeof repo === 'string' ? repo : repo.url;
    const dir = repoTargetDir({ url, workspaceDir, multi });
    const urls = urlsFor ? urlsFor(url) : {};
    try {
      const commit = await commitAll({ dir, message, git });
      if (commit.reason === 'add_failed' || commit.reason === 'commit_failed') {
        results.push({ repo: url, ...commit, pushed: false });
        continue;
      }
      // Skip the network when there is provably nothing to push: no new
      // commit AND the remote-tracking ref matches HEAD. A clean tree with an
      // ahead HEAD still pushes — it retries a previously failed push.
      if (!commit.committed && !(await isAheadOfRemote({ dir, branch, git }))) {
        results.push({ repo: url, ...commit, pushed: 'up_to_date' });
        continue;
      }
      const push = await pushBranch({
        dir,
        repo: url,
        branch,
        gitToken,
        gitProvider,
        urls,
        git,
        sleep,
        log,
      });
      results.push({ repo: url, ...commit, ...push });
    } catch (err) {
      // Defensive: nothing in this module should throw, but a git layer bug
      // must never take down stage bookkeeping.
      log(`commitAndPushAll crashed for ${url}:`, err?.message);
      results.push({
        repo: url,
        committed: false,
        pushed: false,
        reason: 'engine_crashed',
        detail: err?.message,
      });
    }
  }
  const ok = results.every(
    (r) => r.pushed === true || r.pushed === 'empty' || r.pushed === 'up_to_date',
  );
  const committed = results.some((r) => r.committed === true);
  return { ok, committed, results };
};
