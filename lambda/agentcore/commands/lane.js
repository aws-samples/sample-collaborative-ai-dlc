// Lane commands — the engine-owned git lifecycle of one unit lane
// (docs/v2-parallel.md WP5, A3 "lane start" / "lane end").
//
//   init-lane   — runs in the LANE session (fresh microVM + mount): clone the
//                 intent branch, create/check out the unit branch
//                 `<intentBranch>--s<k>-unit-<slug>` from the intent branch's
//                 remote HEAD, and push it so every later self-heal can
//                 re-clone it. Idempotent: an existing remote unit branch
//                 (lane retry / relaunch / wiped mount) is checked out as-is.
//
//   merge-lane  — runs in the INTENT session: merge the unit branch into the
//                 intent branch with --no-ff and push (serialized by the
//                 orchestrator's merge lock; idempotent per repo via the
//                 up_to_date short-circuit). A conflict reports the conflicted
//                 paths and fails the lane — the WP6 conflict-resolution stage
//                 consumes them.
//
// Both are deterministic engine git — the agent CLI is never involved and
// credentials exist only in broker-scoped git child environments. Failures are
// VALUES ({ ok:false, reason, detail }) — the orchestrator decides policy.

import {
  ensureLaneBranch as defaultEnsureLaneBranch,
  mergeBranchNoFf as defaultMergeBranchNoFf,
  fetchOrigin as defaultFetchOrigin,
  runGit as defaultRunGit,
  repoTargetDir,
} from '../git-engine.js';
import {
  checkoutRepo as defaultCheckoutRepo,
  ensureWorkspaceSource as defaultEnsureWorkspaceSource,
} from '../workspace.js';
import { stat } from 'node:fs/promises';
import { repoUrl, repoProvider } from '../../shared/repo-provider.js';

const hasCheckout = async (dir, statFn = stat) => {
  try {
    await statFn(`${dir}/.git`);
    return true;
  } catch {
    return false;
  }
};

// ── init-lane ────────────────────────────────────────────────────────────────
export const initLane = async (
  {
    projectId,
    intentId,
    executionId,
    unitSlug,
    sectionIndex = null,
    repos = [],
    unitBranch,
    intentBranch,
    gitProvider,
    repoProviders = null,
    workspaceDir,
  },
  deps,
) => {
  const {
    store,
    broadcast = async () => {},
    checkoutRepo = defaultCheckoutRepo,
    ensureLaneBranch = defaultEnsureLaneBranch,
    statFn = stat,
    urlsFor = null, // test seam for file:// remotes
  } = deps;

  const publish = (payload) =>
    broadcast({ executionId, intentId, projectId, ...payload }).catch(() => {});

  if (!unitSlug) return { ok: false, reason: 'missing_unit_slug' };
  // A repo-less project has no lane git to prepare — the lane runs
  // artifact-only in its own session; init succeeds as a no-op.
  if (repos.length === 0) {
    return { ok: true, unitSlug, unitBranch: unitBranch ?? null, repos: [] };
  }
  if (!unitBranch || !intentBranch) return { ok: false, reason: 'missing_branch' };

  const multi = repos.length > 1;
  const prepared = [];
  for (const repo of repos) {
    const url = repoUrl(repo);
    const provider = repoProvider(repo, gitProvider, repoProviders);
    const dir = repoTargetDir({ url, workspaceDir, multi });
    // Fresh lane mount → clone first. Checkout the INTENT branch (it exists on
    // the remote — the pre-section stages pushed it); the unit branch is
    // created from it below. A repo that already has a checkout (re-init in a
    // live session) skips the clone — ensureLaneBranch fetches what it needs.
    if (!(await hasCheckout(dir, statFn))) {
      const cloned = await checkoutRepo({
        repo: url,
        branch: intentBranch,
        baseBranch: intentBranch,
        gitProvider: provider,
        projectId,
        executionId,
        targetDir: dir,
      }).catch((e) => ({ error: e?.message ?? String(e) }));
      if (cloned?.error || cloned?.cloned === false) {
        return {
          ok: false,
          reason: 'lane_clone_failed',
          detail: `${url}: ${cloned?.error ?? 'clone failed (repository or project binding unavailable)'}`,
        };
      }
    }
    const lane = await ensureLaneBranch({
      dir,
      repo: url,
      unitBranch,
      intentBranch,
      gitProvider: provider,
      projectId,
      executionId,
      urls: urlsFor ? urlsFor(url) : {},
    });
    if (!lane.ready) {
      return {
        ok: false,
        reason: lane.reason ?? 'lane_branch_failed',
        detail: `${url}: ${lane.detail ?? ''}`.trim(),
      };
    }
    prepared.push({ repo: url, created: lane.created, sha: lane.sha ?? null });
  }

  await store
    ?.appendEvent({
      executionId,
      type: 'v2.unit.lane_ready',
      unitSlug,
      sectionIndex,
      actor: 'agentcore',
      summary: `Lane workspace ready for unit ${unitSlug} on ${unitBranch} (section ${sectionIndex ?? '?'}, ${prepared.length} repo(s))`,
    })
    .catch(() => {});
  await publish({
    action: 'agent.unit',
    unitSlug,
    sectionIndex,
    state: 'LANE_READY',
    unitBranch,
  });

  return { ok: true, unitSlug, unitBranch, repos: prepared };
};

// ── merge-lane ───────────────────────────────────────────────────────────────
export const mergeLane = async (
  {
    projectId,
    intentId,
    executionId,
    unitSlug,
    sectionIndex = null,
    repos = [],
    unitBranch,
    intentBranch,
    baseBranch,
    baseBranches,
    gitProvider,
    repoProviders = null,
    // Commit attribution: merge commits are authored by the starting user,
    // committed by AI-DLC Engine (see git-engine.js gitIdentity).
    gitAuthor = null,
    workspaceDir,
  },
  deps,
) => {
  const {
    store,
    broadcast = async () => {},
    mergeBranchNoFf = defaultMergeBranchNoFf,
    ensureWorkspaceSource = defaultEnsureWorkspaceSource,
    urlsFor = null, // test seam for file:// remotes
  } = deps;

  const publish = (payload) =>
    broadcast({ executionId, intentId, projectId, ...payload }).catch(() => {});

  if (!unitSlug) return { ok: false, reason: 'missing_unit_slug' };
  if (repos.length === 0) {
    // Repo-less lane: completion IS the merge (nothing to integrate).
    return { ok: true, unitSlug, merged: 'empty', results: [] };
  }
  if (!unitBranch || !intentBranch) return { ok: false, reason: 'missing_branch' };

  // Self-heal the INTENT workspace first: its mount can be wiped while the
  // lanes run (redeploy / idle reap) — the merge must never run on nothing.
  const heal = await ensureWorkspaceSource({
    repos,
    branch: intentBranch,
    baseBranch: baseBranch ?? intentBranch,
    baseBranches,
    gitProvider,
    repoProviders,
    projectId,
    executionId,
    workspaceDir,
  }).catch((e) => ({ error: e?.message ?? String(e) }));
  if (heal?.error || heal?.failed?.length) {
    return {
      ok: false,
      reason: 'workspace_restore_failed',
      detail: heal?.error ?? `could not re-clone: ${heal.failed.join(', ')}`,
    };
  }

  const multi = repos.length > 1;
  const results = [];
  for (const repo of repos) {
    const url = repoUrl(repo);
    const provider = repoProvider(repo, gitProvider, repoProviders);
    const dir = repoTargetDir({ url, workspaceDir, multi });
    const res = await mergeBranchNoFf({
      dir,
      repo: url,
      intentBranch,
      unitBranch,
      message: `aidlc(merge): ${unitSlug} — ${executionId}`,
      author: gitAuthor,
      gitProvider: provider,
      projectId,
      executionId,
      urls: urlsFor ? urlsFor(url) : {},
    });
    results.push({ repo: url, ...res });
  }

  const ok = results.every((r) => r.merged === true || r.merged === 'up_to_date');
  const conflicts = results.filter((r) => r.reason === 'merge_conflict');
  const failureReason = conflicts.length
    ? 'merge_conflict'
    : (results.find((r) => r.merged === false)?.reason ?? null);

  await store
    ?.appendEvent({
      executionId,
      type: ok ? 'v2.git.merged' : 'v2.git.merge_failed',
      unitSlug,
      sectionIndex,
      actor: 'agentcore',
      summary: ok
        ? `Engine merged ${unitBranch} into ${intentBranch} (${results
            .map((r) => `${r.repo}@${(r.sha ?? '').slice(0, 8) || r.merged}`)
            .join(', ')})`
        : `Engine merge of ${unitBranch} failed: ${results
            .filter((r) => r.merged === false)
            .map((r) =>
              r.reason === 'merge_conflict'
                ? `${r.repo} conflicts: ${(r.conflicts ?? []).join(', ')}`
                : `${r.repo} (${r.reason})`,
            )
            .join('; ')}`,
    })
    .catch(() => {});
  if (!ok) {
    await publish({
      action: 'agent.unit',
      unitSlug,
      sectionIndex,
      state: 'MERGE_FAILED',
      unitBranch,
    });
  }

  if (!ok) {
    return {
      ok: false,
      reason: failureReason ?? 'merge_failed',
      detail: results
        .filter((r) => r.merged === false)
        .map((r) => `${r.repo}: ${r.detail ?? r.reason}`)
        .join('; '),
      conflicts: conflicts.flatMap((r) => (r.conflicts ?? []).map((f) => `${r.repo}:${f}`)),
      results,
    };
  }
  return { ok: true, unitSlug, results };
};

// Bring the latest remote intent head into a unit branch before its PR/MR is
// promoted from draft. Reuses the engine's idempotent remote-reset + no-ff
// merge primitive with the branch roles reversed.
export const reconcileLane = async (
  {
    projectId,
    intentId,
    executionId,
    unitSlug,
    sectionIndex = null,
    repos = [],
    unitBranch,
    intentBranch,
    gitProvider,
    repoProviders = null,
    gitAuthor = null,
    workspaceDir,
  },
  deps,
) => {
  const {
    store,
    broadcast = async () => {},
    mergeBranchNoFf = defaultMergeBranchNoFf,
    ensureWorkspaceSource = defaultEnsureWorkspaceSource,
    urlsFor = null,
  } = deps;
  if (!unitSlug) return { ok: false, reason: 'missing_unit_slug' };
  if (!unitBranch || !intentBranch) return { ok: false, reason: 'missing_branch' };
  if (repos.length === 0) return { ok: true, unitSlug, results: [] };

  const heal = await ensureWorkspaceSource({
    repos,
    branch: unitBranch,
    baseBranch: intentBranch,
    gitProvider,
    repoProviders,
    projectId,
    executionId,
    workspaceDir,
  }).catch((error) => ({ error: error?.message ?? String(error) }));
  if (heal?.error || heal?.failed?.length) {
    return {
      ok: false,
      reason: 'workspace_restore_failed',
      detail: heal?.error ?? `could not re-clone: ${heal.failed.join(', ')}`,
    };
  }

  const multi = repos.length > 1;
  const results = [];
  for (const repo of repos) {
    const url = repoUrl(repo);
    const provider = repoProvider(repo, gitProvider, repoProviders);
    const result = await mergeBranchNoFf({
      dir: repoTargetDir({ url, workspaceDir, multi }),
      repo: url,
      // Reverse merge: latest intent into the unit branch, then push unit.
      intentBranch: unitBranch,
      unitBranch: intentBranch,
      message: `aidlc(reconcile): ${unitSlug} - ${executionId}`,
      author: gitAuthor,
      gitProvider: provider,
      projectId,
      executionId,
      urls: urlsFor ? urlsFor(url) : {},
    });
    results.push({ repo: url, ...result });
  }
  const ok = results.every((row) => row.merged === true || row.merged === 'up_to_date');
  const conflicts = results.filter((row) => row.reason === 'merge_conflict');
  await store
    ?.appendEvent({
      executionId,
      type: ok ? 'v2.unit.reconciled' : 'v2.unit.reconcile_failed',
      unitSlug,
      sectionIndex,
      actor: 'agentcore',
      summary: ok
        ? `Unit ${unitSlug} reconciled with ${intentBranch}`
        : `Unit ${unitSlug} reconciliation failed: ${results
            .filter((row) => row.merged === false)
            .map((row) => `${row.repo} (${row.reason})`)
            .join(', ')}`,
    })
    .catch(() => {});
  await broadcast({
    executionId,
    intentId,
    projectId,
    action: 'agent.unit',
    unitSlug,
    sectionIndex,
    state: ok ? 'RECONCILED' : 'RECONCILE_FAILED',
  }).catch(() => {});
  return ok
    ? { ok: true, unitSlug, results }
    : {
        ok: false,
        reason: conflicts.length
          ? 'merge_conflict'
          : (results.find((row) => row.merged === false)?.reason ?? 'reconcile_failed'),
        conflicts: conflicts.flatMap((row) =>
          (row.conflicts ?? []).map((file) => `${row.repo}:${file}`),
        ),
        results,
      };
};

// Reset the intent session's working tree to the latest remote intent head
// after provider-side unit integration. Shared stages must never run against a
// stale pre-merge checkout.
export const refreshIntentWorkspace = async (
  {
    projectId,
    executionId,
    repos = [],
    intentBranch,
    baseBranch,
    baseBranches,
    gitProvider,
    repoProviders = null,
    workspaceDir,
  },
  deps,
) => {
  const {
    ensureWorkspaceSource = defaultEnsureWorkspaceSource,
    fetchOrigin = defaultFetchOrigin,
    git = defaultRunGit,
    urlsFor = null,
  } = deps;
  if (repos.length === 0) return { ok: true, results: [] };
  const heal = await ensureWorkspaceSource({
    repos,
    branch: intentBranch,
    baseBranch: baseBranch ?? intentBranch,
    baseBranches,
    gitProvider,
    repoProviders,
    projectId,
    executionId,
    workspaceDir,
  }).catch((error) => ({ error: error?.message ?? String(error) }));
  if (heal?.error || heal?.failed?.length) {
    return {
      ok: false,
      reason: 'workspace_restore_failed',
      detail: heal?.error ?? heal.failed.join(', '),
    };
  }
  const multi = repos.length > 1;
  const results = [];
  for (const repo of repos) {
    const url = repoUrl(repo);
    const provider = repoProvider(repo, gitProvider, repoProviders);
    const dir = repoTargetDir({ url, workspaceDir, multi });
    const fetched = await fetchOrigin({
      dir,
      repo: url,
      gitProvider: provider,
      projectId,
      executionId,
      urls: urlsFor ? urlsFor(url) : {},
      git,
    });
    if (!fetched.fetched) {
      results.push({ repo: url, refreshed: false, reason: fetched.reason });
      continue;
    }
    const checkout = await git(
      ['checkout', '-B', intentBranch, `refs/remotes/origin/${intentBranch}`],
      { cwd: dir },
    );
    results.push({
      repo: url,
      refreshed: checkout.exitCode === 0,
      detail: checkout.stderr?.trim() || null,
    });
  }
  return {
    ok: results.every((row) => row.refreshed),
    results,
    ...(!results.every((row) => row.refreshed) ? { reason: 'refresh_failed' } : {}),
  };
};
