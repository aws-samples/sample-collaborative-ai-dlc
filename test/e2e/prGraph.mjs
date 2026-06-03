// test/e2e/prGraph.mjs
export function repoFromPrUrl(prUrl) {
  const m = /github\.com\/([^/]+)\/([^/]+)\/pull\/\d+/i.exec(String(prUrl || ''));
  return m ? `${m[1]}/${m[2]}` : null;
}

export function extractPullRequests(graph) {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  return nodes
    .filter((n) => n && (n.type === 'PullRequest' || n.label === 'PullRequest'))
    .map((n) => {
      const prUrl = n.pr_url ?? n.properties?.pr_url ?? null;
      return {
        prUrl,
        prNumber: n.pr_number ?? n.properties?.pr_number ?? null,
        repository: repoFromPrUrl(prUrl),
      };
    })
    .filter((p) => p.prUrl);
}

export function assertPrsOnlyOnChangedRepos(prs, changedRepos) {
  const changed = new Set(changedRepos);
  const violations = prs.filter((p) => !changed.has(p.repository)).map((p) => p.repository);
  const missing = [...changed].filter((r) => !prs.some((p) => p.repository === r));
  return { ok: violations.length === 0 && missing.length === 0, violations, missing };
}

export function assertE2EExpectations({
  prs,
  changedRepos,
  expectPrs,
  phaseState,
  requireTaskCompletion = true,
  requireRunningTransition = true,
  requireReview = false,
  reviewState = null,
  enforceRepoAllowList = true,
}) {
  // Only apply the per-repo allow-list when we have an authoritative changed-repo
  // set (a GitHub token resolved it, or it was passed explicitly). Without one,
  // changedRepos is [] and would flag EVERY PR as a violation — so we validate
  // phase signals and PR presence only (see README "Assertion").
  const repoAssertion = enforceRepoAllowList
    ? assertPrsOnlyOnChangedRepos(prs, changedRepos)
    : { ok: true, violations: [], missing: [] };
  const violations = [...repoAssertion.violations];
  const missing = [...repoAssertion.missing];
  const notes = [];

  if (expectPrs && prs.length === 0) {
    violations.push('no-prs-created');
    notes.push('Expected at least one PR, but none were created.');
  }

  if (!expectPrs && prs.length > 0) {
    violations.push('unexpected-prs-created');
    notes.push('Expected no PRs, but one or more PRs were created.');
  }

  // Evidence the phase actually ran: either an observed RUNNING poll, or tasks
  // reaching done (authoritative — a stale terminal status carries neither).
  const ran = Boolean(phaseState?.sawRunning || phaseState?.sawTasksDone);

  // Failed tasks are never a successful completion, regardless of other signals.
  if (phaseState?.tasksFailed) {
    violations.push('tasks-failed');
    notes.push('One or more construction tasks ended in a failed state.');
  }

  if (requireRunningTransition && !ran) {
    violations.push('phase-never-ran');
    notes.push('Construction never exposed a running state or completed tasks after the trigger.');
  }

  if (phaseState?.completed && !ran) {
    violations.push('phase-completed-without-transition');
    notes.push('Construction reported completed before any running/tasks evidence was observed.');
  }

  if (requireTaskCompletion && expectPrs && !phaseState?.sawTasksDone) {
    violations.push('tasks-never-completed');
    notes.push('Expected tasks to complete before asserting PR creation.');
  }

  if (!expectPrs && requireTaskCompletion && !phaseState?.sawTasksDone) {
    notes.push('No-change scenario accepted without completed tasks.');
  }

  if (requireReview) {
    if (!reviewState) {
      violations.push('review-never-ran');
      notes.push('Review was required but the review phase did not run.');
    } else if (!reviewState.hasBlind || !reviewState.hasFull) {
      violations.push('review-incomplete');
      notes.push('Review did not produce both a blind and a full review.');
    }
  }

  return {
    ok: violations.length === 0 && missing.length === 0,
    violations,
    missing,
    changed: changedRepos,
    phaseState,
    reviewState,
    notes,
  };
}
