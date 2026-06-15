// Merge a repo's unmerged construction task branches into its sprint branch via the
// GitHub Merges API. The orchestrator merges task branches locally only in its single
// (primary-repo) working dir, so non-primary repos stay unmerged and create-pr returns
// 409. We reproduce that merge deterministically server-side instead of dropping the repo.
// Returns { merged, conflicts, errors }. A 409 conflict is surfaced (never force-resolved);
// 204 (already merged) is treated as success so re-runs are idempotent.
async function mergeUnmergedTaskBranches({
  owner,
  repo,
  sprintBranch,
  unmergedBranches,
  gitToken,
  fetchImpl = fetch,
}) {
  const result = { merged: [], conflicts: [], errors: [] };
  const headers = {
    Authorization: `token ${gitToken}`,
    Accept: 'application/vnd.github.v3+json',
    'Content-Type': 'application/json',
  };

  for (const taskBranch of unmergedBranches || []) {
    let res;
    try {
      res = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}/merges`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          base: sprintBranch,
          head: taskBranch,
          commit_message: `Merge ${taskBranch} into ${sprintBranch} (auto)`,
        }),
      });
    } catch (e) {
      result.errors.push({ branch: taskBranch, message: e.message });
      continue;
    }

    if (res.status === 201 || res.status === 204) {
      result.merged.push(taskBranch);
    } else if (res.status === 409) {
      result.conflicts.push(taskBranch);
    } else {
      const text = await res.text().catch(() => '');
      result.errors.push({
        branch: taskBranch,
        message: `GitHub merges API returned ${res.status}: ${text.slice(0, 300)}`,
      });
    }
  }

  return result;
}

exports.mergeUnmergedTaskBranches = mergeUnmergedTaskBranches;
