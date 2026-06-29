// Merge a repo's unmerged construction task branches into its sprint branch via
// the active git provider's server-side merge API. The orchestrator merges task
// branches locally only in its single (primary-repo) working dir, so non-primary
// repos stay unmerged and create-pr returns 409. We reproduce that merge
// deterministically server-side instead of dropping the repo. Returns
// { merged, conflicts, errors }. A conflict is surfaced (never force-resolved);
// an already-merged branch is treated as success so re-runs are idempotent.
const { getProvider } = require('./git-providers');

async function mergeUnmergedTaskBranches({
  owner,
  repo,
  sprintBranch,
  unmergedBranches,
  gitToken,
  gitProvider,
  fetchImpl = fetch,
}) {
  const result = { merged: [], conflicts: [], errors: [] };
  const provider = getProvider(gitProvider);
  // The provider addresses repos by its canonical fullName ("owner/repo" for
  // GitHub, "group/project" for GitLab). Callers pass owner+repo split from the
  // GitHub layout; recombine for the provider.
  const repoId = `${owner}/${repo}`;
  const ctx = { token: gitToken, fetchImpl };

  for (const taskBranch of unmergedBranches || []) {
    const outcome = await provider.mergeBranch(ctx, repoId, {
      base: sprintBranch,
      head: taskBranch,
      message: `Merge ${taskBranch} into ${sprintBranch} (auto)`,
    });
    if (outcome === 'merged') {
      result.merged.push(taskBranch);
    } else if (outcome === 'conflict') {
      result.conflicts.push(taskBranch);
    } else {
      result.errors.push({
        branch: taskBranch,
        message: outcome?.error || 'Unknown merge failure',
      });
    }
  }

  return result;
}

exports.mergeUnmergedTaskBranches = mergeUnmergedTaskBranches;
