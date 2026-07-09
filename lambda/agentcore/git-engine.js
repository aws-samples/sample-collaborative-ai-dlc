// git-engine — the engine-owned deterministic git layer (docs/v2-parallel.md WP2).
//
// The agent CLI never commits, pushes, merges, or holds credentials (v1 lost
// code precisely where agents owned commits). Instead, THIS module:
//
//   - commits the whole working tree after every stage exit (success, park,
//     fail) with a deterministic `aidlc(<stage>): …` message,
//   - pushes with v1 pushBranchWithRetry semantics ported from the (since
//     removed) v1 pool worker: retry + linear backoff + remote-HEAD
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
import { mkdir, readFile, writeFile, rm, statfs } from 'node:fs/promises';
import path from 'node:path';
import { buildCloneUrl } from '../shared/git-providers.js';

// Neutral committer identity, passed per-command via `-c` so the repo config
// is never mutated (and the agent can't inherit it for its own commits).
const GIT_IDENTITY = [
  '-c',
  'user.email=aidlc-engine@noreply.local',
  '-c',
  'user.name=AI-DLC Engine',
];

// "On behalf of" attribution: when the orchestrator supplies the starting
// user's identity ({ name, email }, resolved from their OAuth connection),
// engine commits and merges are AUTHORED by the user while the COMMITTER
// stays AI-DLC Engine — GitHub renders "<user> authored and AI-DLC Engine
// committed". Implemented via `-c author.name/author.email` (git ≥2.22):
// unlike `--author` it works for `merge` too, and unlike GIT_AUTHOR_* env it
// survives sanitizedGitEnv (which must keep stripping ambient overrides so
// the agent can't spoof authorship).
//
// Fields are sanitized to a valid git ident (no newlines/angle brackets); an
// unusable identity falls back to the engine-only identity — attribution is
// cosmetic, a commit must never fail over it.
const sanitizeIdentField = (v) => (typeof v === 'string' ? v.replace(/[<>\n\r]/g, ' ').trim() : '');

export const gitIdentity = (author = null) => {
  const name = sanitizeIdentField(author?.name);
  const email = sanitizeIdentField(author?.email);
  if (!name || !email) return GIT_IDENTITY;
  return [...GIT_IDENTITY, '-c', `author.name=${name}`, '-c', `author.email=${email}`];
};

// Runtime files that live INSIDE the workspace mount — which, for a
// single-repo project, IS the repo checkout — but are NEVER the user's work
// and must never be captured by `git add -A`:
//   .aidlc/       engine-materialized rules.md + mcp-config.json (infra env)
//   .kiro/        engine-materialized Kiro agent config (same env)
//   .claude/      Claude's conversation store (CLAUDE_CONFIG_DIR)
//   .kiro-data/   Kiro's durable SQLite store (V2_KIRO_STORE_DIR)
//   node_modules  the engine-owned off-mount SYMLINK (workspace.js
//                 redirectHeavyDirs) — no trailing slash so the pattern
//                 matches the symlink itself, not only a directory
// Enforced via `.git/info/exclude` — repo-LOCAL (never pushed, never touches
// the user's .gitignore) and honored by `git add -A` and status. Excludes do
// not untrack: a repo that ALREADY tracks such a path keeps it (the user's
// explicit choice wins over our hygiene default).
export const RUNTIME_EXCLUDES = ['.aidlc/', '.kiro/', '.claude/', '.kiro-data/', 'node_modules'];
// Marker is VERSIONED: bumping it makes ensureRuntimeExcludes append the new
// block on warm sessions that already hold an older one (duplicate patterns
// are harmless to git; a stale block missing an entry is not).
const EXCLUDE_MARKER = '# aidlc-engine runtime excludes v2 (managed; do not edit this block)';

export const ensureRuntimeExcludes = async ({ dir }) => {
  try {
    const infoDir = path.join(dir, '.git', 'info');
    await mkdir(infoDir, { recursive: true });
    const excludePath = path.join(infoDir, 'exclude');
    const existing = await readFile(excludePath, 'utf8').catch(() => '');
    if (existing.includes(EXCLUDE_MARKER)) return { ensured: true };
    const block = [EXCLUDE_MARKER, ...RUNTIME_EXCLUDES].join('\n');
    await writeFile(excludePath, `${existing.replace(/\n?$/, '\n')}${block}\n`, 'utf8');
    return { ensured: true };
  } catch (e) {
    // Never let hygiene bookkeeping break a commit — but a failure here means
    // runtime files could leak into the repo, so it must be visible.
    console.error('[git-engine] runtime-exclude write failed:', e?.message);
    return { ensured: false, error: e?.message };
  }
};

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
//   { committed: false, reason: 'add_failed' | 'commit_failed', detail, dirty }
//
// Durability hardening (the 2026-07 "no changes" incident: an ENOSPC'd mount
// made both engine commits fail, the stages still succeeded, and the intent
// finished with zero durable work):
//   - add/commit failures are RETRIED with backoff — the session mount's NFS
//     backup pipeline throttles writes transiently ("waiting to be backed up"),
//   - a persistent ENOSPC triggers the self-heal: delete git-ignored,
//     re-creatable directories (node_modules & friends) and retry once —
//     losing a commit is strictly worse than a dependency re-install,
//   - a terminal failure reports `dirty` (does the tree hold uncommitted
//     work?) so run-stage can fail the stage when real work is at risk.
export const commitAll = async ({
  dir,
  message,
  author = null,
  git = runGit,
  attempts = 3,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  log = (...a) => console.error('[git-engine]', ...a),
  rmDir = (p) => rm(p, { recursive: true, force: true }),
}) => {
  // Runtime files (.aidlc/.claude/…) must never enter the user's history —
  // ensure the repo-local excludes before staging the tree.
  await ensureRuntimeExcludes({ dir });

  const attemptOnce = async () => {
    const add = await git(['add', '-A'], { cwd: dir });
    if (add.exitCode !== 0) {
      return { committed: false, reason: 'add_failed', detail: add.stderr.trim() };
    }
    const status = await git(['status', '--porcelain'], { cwd: dir });
    if (status.exitCode === 0 && status.stdout.trim() === '') {
      return { committed: false, reason: 'clean' };
    }
    const commit = await git([...gitIdentity(author), 'commit', '-m', message], { cwd: dir });
    if (commit.exitCode !== 0) {
      return { committed: false, reason: 'commit_failed', detail: commit.stderr.trim() };
    }
    const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
    return { committed: true, sha: head.stdout.trim() || null };
  };

  let last = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    last = await attemptOnce();
    if (last.committed || last.reason === 'clean') return last;
    log(
      `commit attempt ${attempt}/${attempts} failed for ${dir}: ${last.reason}${
        last.detail ? ` — ${last.detail}` : ''
      }`,
    );
    if (attempt < attempts) await sleep(attempt * 2000);
  }

  // ENOSPC self-heal: reclaim git-ignored re-creatable directories, then one
  // final attempt. Only ignored paths are ever deleted — the agent's actual
  // work is never ignored, so nothing the commit is trying to save is touched.
  if (isEnospc(last?.detail)) {
    const freed = await reclaimIgnoredDirs({ dir, git, rmDir, log });
    if (freed.length > 0) {
      log(`ENOSPC self-heal reclaimed ${freed.join(', ')} in ${dir}; retrying commit`);
      const healed = await attemptOnce();
      if (healed.committed || healed.reason === 'clean') return { ...healed, reclaimed: freed };
      last = { ...healed, reclaimed: freed };
    }
  }

  // Terminal durability failure — report whether user work sits uncommitted in
  // the tree. An unreadable status counts as dirty: unknown durability must
  // fail loud, not pass silent.
  const dirtyStatus = await git(['status', '--porcelain'], { cwd: dir });
  const dirty = dirtyStatus.exitCode === 0 ? dirtyStatus.stdout.trim() !== '' : true;
  return { committed: false, ...last, dirty };
};

// True when a git failure is caused by a full filesystem (the session mount is
// a fixed 1 GiB — AgentCore offers no larger size).
export const isEnospc = (detail) => /no space left on device|enospc/i.test(detail ?? '');

// Directory basenames that are safe to reclaim when the mount is full: they
// are git-ignored AND re-creatable by a dependency install or build.
export const RECLAIMABLE_DIR_NAMES = new Set([
  'node_modules',
  '.cache',
  '.npm',
  '.turbo',
  '.vite',
  '.parcel-cache',
  '.pnpm-store',
  '.gradle',
  'target',
  '.venv',
]);

// Enumerate git-ignored directories (collapsed `!! dir/` rows from
// `git status --ignored`) whose basename marks them re-creatable, and delete
// them. Only paths that resolve INSIDE the repo dir are ever touched.
export const reclaimIgnoredDirs = async ({
  dir,
  git = runGit,
  rmDir = (p) => rm(p, { recursive: true, force: true }),
  log = (...a) => console.error('[git-engine]', ...a),
}) => {
  const status = await git(['status', '--porcelain', '--ignored'], { cwd: dir });
  if (status.exitCode !== 0) return [];
  const freed = [];
  const root = path.resolve(dir);
  for (const line of status.stdout.split('\n')) {
    if (!line.startsWith('!! ')) continue;
    const rel = line.slice(3).trim();
    if (!rel.endsWith('/')) continue; // only whole ignored directories
    const relDir = rel.replace(/\/$/, '');
    const base = relDir.split('/').pop();
    if (!RECLAIMABLE_DIR_NAMES.has(base)) continue;
    const abs = path.resolve(root, relDir);
    if (abs !== root && !abs.startsWith(root + path.sep)) continue; // never escape the repo
    try {
      await rmDir(abs);
      freed.push(relDir);
    } catch (e) {
      log(`reclaim failed for ${relDir}:`, e?.message);
    }
  }
  return freed;
};

// Free bytes on the filesystem containing `dir` (null when unreadable). The
// disk preflight in run-stage uses this to warn BEFORE work is attempted on a
// nearly-full session mount.
export const freeDiskBytes = async ({ dir, statfsFn = statfs }) => {
  try {
    const s = await statfsFn(dir);
    return Number(s.bavail) * Number(s.bsize);
  } catch {
    return null;
  }
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
// (single repo → workspaceDir; multi → workspaceDir/<owner>/<repo>). Exported
// for the lane commands (init-lane / merge-lane) that loop repos themselves.
export const repoTargetDir = ({ url, workspaceDir, multi }) =>
  multi ? path.join(workspaceDir, url) : workspaceDir;

// Authenticated fetch — the READ counterpart of pushBranch's token window.
// Clone is the only authenticated read the engine had; lane branching and
// merge-back both need current remote refs first. The tokenized URL exists
// only between the set-url and the finally-scrub. Never throws.
//   { fetched: true }                    — remote refs are current
//   { fetched: false, reason, detail }   — set-url or fetch failure
export const fetchOrigin = async ({
  dir,
  repo,
  gitToken,
  gitProvider,
  urls = {},
  git = runGit,
}) => {
  const authUrl = urls.auth ?? buildCloneUrl(gitProvider, repo, gitToken);
  const setAuth = await git(['remote', 'set-url', 'origin', authUrl], { cwd: dir });
  if (setAuth.exitCode !== 0) {
    return { fetched: false, reason: 'remote_set_url_failed', detail: setAuth.stderr.trim() };
  }
  try {
    const fetch = await git(['fetch', 'origin', '--prune'], { cwd: dir });
    if (fetch.exitCode !== 0) {
      return { fetched: false, reason: 'fetch_failed', detail: fetch.stderr.trim().slice(-500) };
    }
    return { fetched: true };
  } finally {
    await scrubRemote({ dir, repo, gitProvider, urls, git });
  }
};

// Ensure the unit-lane branch exists locally AND remotely, branched from the
// intent branch's remote HEAD (docs/v2-parallel.md A3: lane start). Remote
// state is the truth: an existing remote unit branch (lane retry / relaunch /
// re-init after a wiped mount) is checked out as-is; otherwise the branch is
// created from origin/<intentBranch> and pushed so every later self-heal can
// re-clone it. `checkout -B` resets any stale local ref deterministically —
// init-lane runs only at lane START, when the remote is current (stage-exit
// pushes keep it so). Never throws.
//   { ready: true,  created, sha }       — checkout on the unit branch
//   { ready: false, reason, detail? }    — fetch / missing intent branch / git failure
export const ensureLaneBranch = async ({
  dir,
  repo,
  unitBranch,
  intentBranch,
  gitToken,
  gitProvider,
  urls = {},
  git = runGit,
  sleep,
  log = (...a) => console.error('[git-engine]', ...a),
}) => {
  if (!unitBranch || !intentBranch) return { ready: false, reason: 'missing_branch' };
  const fetch = await fetchOrigin({ dir, repo, gitToken, gitProvider, urls, git });
  if (!fetch.fetched) return { ready: false, ...fetch };

  const remoteUnit = await git(['rev-parse', '--verify', `refs/remotes/origin/${unitBranch}`], {
    cwd: dir,
  });
  if (remoteUnit.exitCode === 0) {
    const checkout = await git(
      ['checkout', '-B', unitBranch, `refs/remotes/origin/${unitBranch}`],
      { cwd: dir },
    );
    if (checkout.exitCode !== 0) {
      return { ready: false, reason: 'checkout_failed', detail: checkout.stderr.trim() };
    }
    return { ready: true, created: false, sha: remoteUnit.stdout.trim() };
  }

  const remoteIntent = await git(['rev-parse', '--verify', `refs/remotes/origin/${intentBranch}`], {
    cwd: dir,
  });
  if (remoteIntent.exitCode !== 0) {
    // The intent branch must exist remotely before any lane can fork it (the
    // pre-section stages pushed it). Its absence is a hard, actionable error.
    return { ready: false, reason: 'intent_branch_missing', detail: intentBranch };
  }
  const create = await git(['checkout', '-B', unitBranch, `refs/remotes/origin/${intentBranch}`], {
    cwd: dir,
  });
  if (create.exitCode !== 0) {
    return { ready: false, reason: 'checkout_failed', detail: create.stderr.trim() };
  }
  // Register the branch remotely NOW: a later wiped-mount self-heal re-clones
  // and checks the branch out from the remote — it must already be there.
  const push = await pushBranch({
    dir,
    repo,
    branch: unitBranch,
    gitToken,
    gitProvider,
    urls,
    git,
    sleep,
    log,
  });
  if (push.pushed !== true && push.pushed !== 'empty') {
    return { ready: false, reason: push.reason ?? 'push_failed', detail: push.detail };
  }
  return { ready: true, created: true, sha: remoteIntent.stdout.trim() };
};

// Serialized fan-in merge (docs/v2-parallel.md A3: lane end): merge the unit
// branch into the intent branch with --no-ff and push. Runs in the INTENT
// session's workspace; the caller (orchestrator) serializes calls via its
// merge lock — this function additionally makes each call IDEMPOTENT so a
// re-dispatched merge step (durable retry) is safe:
//   - the local intent branch is reset to the remote (`checkout -B` onto
//     origin/<intentBranch>) so remote state is always the merge base,
//   - an already-merged unit branch short-circuits (`up_to_date`).
// A conflict aborts cleanly (tree left pristine) and reports the conflicted
// paths — the WP6 conflict-resolution stage consumes them; until then the
// lane fails halt-and-ask style. Never throws.
//   { merged: true,  sha, pushed }             — merge commit on the remote
//   { merged: 'up_to_date', sha }              — nothing to do (replay/retry)
//   { merged: false, reason, detail?, conflicts? }
export const mergeBranchNoFf = async ({
  dir,
  repo,
  intentBranch,
  unitBranch,
  message,
  author = null,
  gitToken,
  gitProvider,
  urls = {},
  git = runGit,
  sleep,
  log = (...a) => console.error('[git-engine]', ...a),
}) => {
  if (!unitBranch || !intentBranch) return { merged: false, reason: 'missing_branch' };
  const fetch = await fetchOrigin({ dir, repo, gitToken, gitProvider, urls, git });
  if (!fetch.fetched) return { merged: false, ...fetch };

  const remoteUnit = await git(['rev-parse', '--verify', `refs/remotes/origin/${unitBranch}`], {
    cwd: dir,
  });
  if (remoteUnit.exitCode !== 0) {
    return { merged: false, reason: 'unit_branch_missing', detail: unitBranch };
  }
  const remoteIntent = await git(['rev-parse', '--verify', `refs/remotes/origin/${intentBranch}`], {
    cwd: dir,
  });
  if (remoteIntent.exitCode !== 0) {
    return { merged: false, reason: 'intent_branch_missing', detail: intentBranch };
  }

  // Remote is the merge base: reset the local intent branch onto it so a
  // stale local ref (parallel merges landed since this workspace last moved)
  // can never produce a divergent merge.
  const checkout = await git(
    ['checkout', '-B', intentBranch, `refs/remotes/origin/${intentBranch}`],
    { cwd: dir },
  );
  if (checkout.exitCode !== 0) {
    return { merged: false, reason: 'checkout_failed', detail: checkout.stderr.trim() };
  }

  // Idempotency: a re-dispatched merge step after the merge already landed.
  const ancestor = await git(
    ['merge-base', '--is-ancestor', `refs/remotes/origin/${unitBranch}`, 'HEAD'],
    { cwd: dir },
  );
  if (ancestor.exitCode === 0) {
    return { merged: 'up_to_date', sha: remoteIntent.stdout.trim() };
  }

  const merge = await git(
    [
      ...gitIdentity(author),
      'merge',
      '--no-ff',
      '-m',
      message,
      `refs/remotes/origin/${unitBranch}`,
    ],
    { cwd: dir },
  );
  if (merge.exitCode !== 0) {
    // Conflict → collect the conflicted paths, then leave the tree PRISTINE.
    const conflicted = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir });
    const conflicts = conflicted.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    await git(['merge', '--abort'], { cwd: dir }); // best-effort; no-op when the merge never started
    return {
      merged: false,
      reason: conflicts.length ? 'merge_conflict' : 'merge_failed',
      detail: merge.stderr.trim().slice(-500),
      conflicts,
    };
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  const push = await pushBranch({
    dir,
    repo,
    branch: intentBranch,
    gitToken,
    gitProvider,
    urls,
    git,
    sleep,
    log,
  });
  if (push.pushed !== true) {
    // Merged locally but not on the remote — the retry path resets onto the
    // remote and redoes the merge, so report this as a plain failure value.
    return { merged: false, reason: push.reason ?? 'push_failed', detail: push.detail };
  }
  return { merged: true, sha: head.stdout.trim() || null, pushed: true };
};

// ── Conflict-resolution primitives (docs/v2-parallel.md WP6) ────────────────
// The conflict-resolution stage runs in the LANE session: the intent branch is
// merged INTO the unit branch (reverse direction), leaving real conflict
// markers for the agent to resolve; the ENGINE then validates + concludes the
// merge commit and pushes the unit branch. merge-lane's retry is then clean —
// the intent branch never holds an in-progress merge.

// Start the reverse merge and LEAVE the conflicts in the tree. Never throws.
//   { conflicted: true,  conflicts: [paths] }  — markers in the tree, MERGE_HEAD set
//   { conflicted: false, merged: true, sha }   — merged cleanly (nothing to resolve)
//   { conflicted: false, merged: 'up_to_date' }— intent already contained
//   { conflicted: false, error, detail }       — fetch/checkout/merge machinery failure
export const beginConflictMerge = async ({
  dir,
  repo,
  unitBranch,
  intentBranch,
  message,
  author = null,
  gitToken,
  gitProvider,
  urls = {},
  git = runGit,
}) => {
  if (!unitBranch || !intentBranch) return { conflicted: false, error: 'missing_branch' };
  const fetch = await fetchOrigin({ dir, repo, gitToken, gitProvider, urls, git });
  if (!fetch.fetched) return { conflicted: false, error: fetch.reason, detail: fetch.detail };

  const checkout = await git(['checkout', '-B', unitBranch, `refs/remotes/origin/${unitBranch}`], {
    cwd: dir,
  });
  if (checkout.exitCode !== 0) {
    return { conflicted: false, error: 'checkout_failed', detail: checkout.stderr.trim() };
  }
  const ancestor = await git(
    ['merge-base', '--is-ancestor', `refs/remotes/origin/${intentBranch}`, 'HEAD'],
    { cwd: dir },
  );
  if (ancestor.exitCode === 0) return { conflicted: false, merged: 'up_to_date' };

  const merge = await git(
    [
      ...gitIdentity(author),
      'merge',
      '--no-ff',
      '-m',
      message,
      `refs/remotes/origin/${intentBranch}`,
    ],
    { cwd: dir },
  );
  if (merge.exitCode === 0) {
    const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
    return { conflicted: false, merged: true, sha: head.stdout.trim() || null };
  }
  const conflicted = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir });
  const conflicts = conflicted.stdout
    .split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  if (conflicts.length === 0) {
    // Merge failed for a NON-conflict reason — leave nothing half-done.
    await git(['merge', '--abort'], { cwd: dir });
    return { conflicted: false, error: 'merge_failed', detail: merge.stderr.trim().slice(-500) };
  }
  return { conflicted: true, conflicts };
};

// Conflict-marker scan — the deterministic verification gate after the agent
// edited the conflicted files. `git diff --check` is unreliable post-`add`;
// scanning the named files for marker lines is exact and content-based.
const MARKER_RE = /^(<{7}(\s|$)|={7}$|>{7}(\s|$)|\|{7}(\s|$))/m;
export const findRemainingConflictMarkers = async ({ dir, files, readFileImpl }) => {
  const readFileFn = readFileImpl ?? readFile;
  const remaining = [];
  for (const file of files) {
    try {
      const text = await readFileFn(path.join(dir, file), 'utf8');
      if (MARKER_RE.test(text)) remaining.push(file);
    } catch {
      // A conflicted file the agent DELETED counts as resolved-by-deletion;
      // `git add -A` below records the deletion.
    }
  }
  return remaining;
};

// Conclude the resolved merge: verify no markers remain in the previously
// conflicted files, stage everything, commit (completing MERGE_HEAD with the
// engine identity), and push the unit branch. On validation failure the
// in-progress merge is ABORTED (pristine tree for the halt-and-ask retry).
//   { concluded: true, sha, pushed }
//   { concluded: false, reason: 'markers_remain', remaining } — aborted
//   { concluded: false, reason, detail }                      — aborted
export const concludeConflictMerge = async ({
  dir,
  repo,
  unitBranch,
  conflicts = [],
  author = null,
  gitToken,
  gitProvider,
  urls = {},
  git = runGit,
  sleep,
  log = (...a) => console.error('[git-engine]', ...a),
}) => {
  const abort = async () => {
    await git(['merge', '--abort'], { cwd: dir });
  };
  const remaining = await findRemainingConflictMarkers({ dir, files: conflicts });
  if (remaining.length) {
    await abort();
    return { concluded: false, reason: 'markers_remain', remaining };
  }
  // A CLEAN reverse merge was auto-committed by beginConflictMerge (no
  // MERGE_HEAD) — nothing to stage or commit; only the push remains.
  const inProgress =
    (await git(['rev-parse', '--verify', 'MERGE_HEAD'], { cwd: dir })).exitCode === 0;
  if (inProgress) {
    await ensureRuntimeExcludes({ dir });
    const add = await git(['add', '-A'], { cwd: dir });
    if (add.exitCode !== 0) {
      await abort();
      return { concluded: false, reason: 'add_failed', detail: add.stderr.trim() };
    }
    // Anything still unmerged in the INDEX (a path the scan couldn't see, e.g.
    // a rename/rename conflict) blocks the commit — verify the index is clean.
    const unmerged = await git(['diff', '--name-only', '--diff-filter=U'], { cwd: dir });
    if (unmerged.stdout.trim() !== '') {
      await abort();
      return {
        concluded: false,
        reason: 'markers_remain',
        remaining: unmerged.stdout.trim().split('\n'),
      };
    }
    // `git commit` with no -m completes the merge using MERGE_MSG (the message
    // beginConflictMerge supplied via -m).
    const commit = await git([...gitIdentity(author), 'commit', '--no-edit'], { cwd: dir });
    if (commit.exitCode !== 0) {
      await abort();
      return { concluded: false, reason: 'commit_failed', detail: commit.stderr.trim() };
    }
  }
  const head = await git(['rev-parse', 'HEAD'], { cwd: dir });
  const push = await pushBranch({
    dir,
    repo,
    branch: unitBranch,
    gitToken,
    gitProvider,
    urls,
    git,
    sleep,
    log,
  });
  if (push.pushed !== true) {
    // The resolution commit exists locally; the retry path re-begins from the
    // remote, so report a plain failure value (no state to unwind).
    return { concluded: false, reason: push.reason ?? 'push_failed', detail: push.detail };
  }
  return { concluded: true, sha: head.stdout.trim() || null, pushed: true };
};

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
  author = null,
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
      const commit = await commitAll({ dir, message, author, git, sleep, log });
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
