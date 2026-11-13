// Lane sync: bring the intent branch's latest head into a unit lane before a
// stage runs, so a lane sees work that reached the intent branch after the lane
// was cut (an earlier unit merged, or a change merged into the intent branch
// directly). Opt-in with LANE_SYNC_POLICY=before-stage; the default, none,
// leaves lanes as they are until merge-back or reconciliation.
//
// The merge is the same engine operation reconciliation uses (mergeBranchNoFf
// with the branch roles reversed): fetch, reset the local unit branch onto its
// remote, merge origin/<intentBranch> --no-ff and push the unit branch. A
// conflict is aborted, leaving the lane as it was; merge-back or reconciliation
// still resolves it later. A repo with uncommitted or unpushed work is skipped,
// because the reset would drop that work. Never throws.
import {
  mergeBranchNoFf as defaultMergeBranchNoFf,
  isAheadOfRemote as defaultIsAheadOfRemote,
  runGit as defaultRunGit,
  repoTargetDir,
} from './git-engine.js';
import { repoUrl, repoProvider } from '../shared/repo-provider.js';
import { createEngineCommitMessages } from './commit-message.js';

export const LANE_SYNC_POLICIES = Object.freeze(['none', 'before-stage']);

export const laneSyncPolicy = (env = process.env) =>
  env?.LANE_SYNC_POLICY === 'before-stage' ? 'before-stage' : 'none';

const SWAPPED_REASONS = Object.freeze({
  unit_branch_missing: 'intent_branch_missing',
  intent_branch_missing: 'unit_branch_missing',
});

// Uncommitted changes, or commits the remote unit branch doesn't have.
const hasLocalWork = async ({ dir, branch, git, isAheadOfRemote }) => {
  const status = await git(['status', '--porcelain'], { cwd: dir });
  if (status.exitCode !== 0) return 'status_failed';
  if (status.stdout.trim()) return 'uncommitted_changes';
  if (await isAheadOfRemote({ dir, branch, git })) return 'unpushed_commits';
  return null;
};

// Returns { synced, results }: synced is true when at least one repo took a
// merge commit. Each result is { repo, outcome, sha?, reason?, detail?,
// conflicts? } with outcome 'merged', 'up_to_date', 'skipped', 'conflict' or
// 'failed'.
export const syncLaneWithIntent = async (
  {
    projectId,
    executionId,
    unitSlug,
    repos = [],
    unitBranch,
    intentBranch,
    gitProvider,
    repoProviders = null,
    gitAuthor = null,
    workspaceDir,
  },
  {
    store,
    env = process.env,
    mergeBranchNoFf = defaultMergeBranchNoFf,
    isAheadOfRemote = defaultIsAheadOfRemote,
    git = defaultRunGit,
    // Test seams. Production leaves both unset: git-engine then gets a
    // credential for each fetch and push from the credential broker
    // (git-auth.js withGitCredential, CREDENTIAL_BROKER_FUNCTION), the same path
    // as the stage-exit push and reconciliation.
    urlsFor = null,
    withGitCredential = undefined,
  } = {},
) => {
  if (!unitBranch || !intentBranch || unitBranch === intentBranch || repos.length === 0) {
    return { synced: false, results: [] };
  }
  const multi = repos.length > 1;
  const message = await createEngineCommitMessages({ store, executionId, env })({
    kind: 'reconcile',
    unitSlug,
  });
  const results = [];
  for (const repo of repos) {
    const url = repoUrl(repo);
    try {
      const dir = repoTargetDir({ url, workspaceDir, multi });
      const localWork = await hasLocalWork({ dir, branch: unitBranch, git, isAheadOfRemote });
      if (localWork) {
        results.push({ repo: url, outcome: 'skipped', reason: localWork });
        continue;
      }
      const before = (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
      const merge = await mergeBranchNoFf({
        dir,
        repo: url,
        // Reverse merge: the intent branch into the unit branch, then push unit.
        intentBranch: unitBranch,
        unitBranch: intentBranch,
        message,
        author: gitAuthor,
        gitProvider: repoProvider(repo, gitProvider, repoProviders),
        projectId,
        executionId,
        urls: urlsFor ? urlsFor(url) : {},
        ...(withGitCredential ? { withGitCredential } : {}),
      });
      if (merge.merged === true) {
        results.push({ repo: url, outcome: 'merged', sha: merge.sha ?? null });
      } else if (merge.merged === 'up_to_date') {
        results.push({ repo: url, outcome: 'up_to_date' });
      } else {
        // A merge that was made but not pushed (a push rejected because someone
        // pushed to the unit branch meanwhile, or a network failure) must not
        // stay in the checkout: the stage would run on a tree the remote doesn't
        // have, and its own push would be rejected too. The checkout had no
        // local work, so putting it back on the lane's previous head loses
        // nothing.
        const after = (await git(['rev-parse', 'HEAD'], { cwd: dir })).stdout.trim();
        if (before && after && after !== before) {
          await git(['reset', '--hard', before], { cwd: dir });
        }
        results.push({
          repo: url,
          outcome: merge.reason === 'merge_conflict' ? 'conflict' : 'failed',
          // The merge ran with the branch roles reversed; name them as the lane sees them.
          reason: SWAPPED_REASONS[merge.reason] ?? merge.reason ?? 'merge_failed',
          detail: merge.detail ?? null,
          conflicts: merge.conflicts ?? [],
        });
      }
    } catch (error) {
      results.push({
        repo: url,
        outcome: 'failed',
        reason: 'sync_error',
        detail: error?.message ?? String(error),
      });
    }
  }
  return { synced: results.some((row) => row.outcome === 'merged'), results };
};

// One event per sync that did something worth telling the human: a merge, a
// conflict, a skip or a failure. Nothing is recorded when every repo was up to
// date.
const list = (rows, field = 'reason') =>
  rows.map((row) => `${row.repo}${row[field] ? ` (${row[field]})` : ''}`).join(', ');

export const laneSyncEvent = ({ unitSlug, intentBranch, results = [] }) => {
  const by = (outcome) => results.filter((row) => row.outcome === outcome);
  const conflicts = by('conflict');
  const failed = [...by('failed'), ...by('skipped')];
  const merged = by('merged');
  if (conflicts.length) {
    const files = conflicts.flatMap((row) => row.conflicts.map((file) => `${row.repo}:${file}`));
    return {
      type: 'v2.lane.sync_conflict',
      summary: `Lane ${unitSlug} not synced with ${intentBranch}: merge conflicts in ${files.join(', ') || list(conflicts)}. The lane continues on its current branch; the conflict is resolved at merge-back.`,
    };
  }
  if (failed.length) {
    return {
      type: 'v2.lane.sync_failed',
      summary: `Lane ${unitSlug} not synced with ${intentBranch}: ${list(failed)}${merged.length ? `; synced ${list(merged, 'sha')}` : ''}`,
    };
  }
  if (merged.length) {
    return {
      type: 'v2.lane.synced',
      summary: `Lane ${unitSlug} synced with ${intentBranch}: ${list(merged, 'sha')}`,
    };
  }
  return null;
};
