// test/e2e/teardown.mjs
async function gh(method, token, path, body) {
  const res = await fetch(`https://api.github.com${path}`, {
    method,
    headers: {
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'aidlc-e2e-harness',
      Authorization: `Bearer ${token}`,
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res;
}

export async function closePr({ token, owner, repo, prNumber }) {
  const res = await gh('PATCH', token, `/repos/${owner}/${repo}/pulls/${prNumber}`, {
    state: 'closed',
  });
  return res.ok;
}

export async function deleteBranch({ token, owner, repo, branch }) {
  const res = await gh(
    'DELETE',
    token,
    `/repos/${owner}/${repo}/git/refs/heads/${encodeURIComponent(branch)}`,
  );
  return res.ok || res.status === 422; // 422 if already gone
}

export async function teardownRun({ token, prs, branch }) {
  const results = [];
  for (const pr of prs) {
    const [owner, repo] = String(pr.repository || '').split('/');
    if (!owner || !repo || !pr.prNumber) continue;
    const closed = await closePr({ token, owner, repo, prNumber: pr.prNumber }).catch(() => false);
    const branchDeleted = await deleteBranch({ token, owner, repo, branch }).catch(() => false);
    results.push({ repository: pr.repository, closed, branchDeleted });
  }
  return results;
}

/**
 * Always clean up Neptune: delete sprint (cascades graph children) then project.
 * This prevents polluting staging with test data. PRs/branches/logs are kept.
 */
export async function cleanupProject({ api, projectId, sprintId }) {
  const results = { sprintDeleted: false, projectDeleted: false };
  if (!api || !projectId) return results;
  try {
    if (sprintId) {
      await api.del(`/projects/${projectId}/sprints/${sprintId}`);
      results.sprintDeleted = true;
    }
    await api.del(`/projects/${projectId}`);
    results.projectDeleted = true;
  } catch (e) {
    results.error = e.message;
  }
  return results;
}

/**
 * Builds a human-readable advisory when a cleanup did not fully remove the
 * Neptune project/sprint, so leaks are visible in the final report instead of
 * being silently swallowed. Pure/testable. Returns null when cleanup was clean
 * (or was intentionally skipped). `cleanup` is the object returned by
 * cleanupProject (possibly with an `error`), or one shaped `{ error }` if the
 * call itself rejected.
 */
export function cleanupAdvisory(cleanup, { projectId, sprintId } = {}) {
  if (!cleanup || typeof cleanup !== 'object') return null;
  const reasons = [];
  if (cleanup.error) reasons.push(`error: ${cleanup.error}`);
  if (projectId && cleanup.projectDeleted === false)
    reasons.push(`project ${projectId} not deleted`);
  if (sprintId && cleanup.sprintDeleted === false) reasons.push(`sprint ${sprintId} not deleted`);
  if (!reasons.length) return null;
  return `Cleanup incomplete — possible leaked Neptune resources (${reasons.join('; ')}).`;
}
