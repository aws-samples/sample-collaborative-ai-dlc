// Per-repo PR-creation loop for multi-repo projects, extracted from
// trigger_pr_creation so the orchestration (409 → server-side merge → retry,
// per-repo error containment) is unit-testable without Neptune/Lambda mocks.
//
// Each repo is processed independently: any failure — including a malformed
// repo URL that makes parseOwnerRepo throw — is recorded in `failedRepos` and
// never aborts PR creation for the remaining repos.
//
// failedRepos entry shapes (the construction orchestrator prompt documents the
// remediation for each — keep them in sync):
//   { repository, error, conflicts, mergeErrors } — server-side auto-merge could not complete
//   { repository, error, unmergedBranches }       — create-pr still reports unmerged branches after
//                                                   the merge+retry (a new task branch appeared)
//   { repository, error }                         — any other create-pr / infrastructure failure
//
// skippedRepos entry shape — NOT a failure, never retried or escalated:
//   { repository, reason: 'no_changes' } — the sprint produced no commits for this
//                                          repo (create-pr returned skipped: true)

const { mergeUnmergedTaskBranches } = require('./merge-task-branches');

async function createPrsForRepos({
  repos, // [{ url }] — env.gitRepos
  sprintBranch,
  gitToken,
  gitProvider, // 'github' | 'gitlab' — selects the server-side merge API
  invokeCreatePr, // async (repoUrl) => parsed create-pr Lambda response
  parseOwnerRepo, // (s) => { owner, repo } — throws on malformed input
  mergeFn = mergeUnmergedTaskBranches,
}) {
  const prResults = [];
  const failedRepos = [];
  const skippedRepos = [];

  for (const repo of repos) {
    try {
      let resp = await invokeCreatePr(repo.url);

      if (
        resp.statusCode === 409 &&
        Array.isArray(resp.unmergedBranches) &&
        resp.unmergedBranches.length
      ) {
        const { owner, repo: repoName } = parseOwnerRepo(repo.url);
        const mergeResult = await mergeFn({
          owner,
          repo: repoName,
          sprintBranch,
          unmergedBranches: resp.unmergedBranches,
          gitToken,
          gitProvider,
        });

        if (mergeResult.conflicts.length || mergeResult.errors.length) {
          failedRepos.push({
            repository: repo.url,
            error: 'Unmerged construction task branches could not be auto-merged',
            conflicts: mergeResult.conflicts,
            mergeErrors: mergeResult.errors,
          });
          continue;
        }

        resp = await invokeCreatePr(repo.url);
      }

      if (resp.skipped === true) {
        skippedRepos.push({ repository: repo.url, reason: resp.reason || 'no_changes' });
        console.error(`[trigger_pr_creation] Skipped ${repo.url}: ${resp.reason || 'no_changes'}`);
        continue;
      }

      if (resp.prUrl && resp.prNumber) {
        prResults.push({ ...resp, repository: repo.url });
      } else {
        failedRepos.push({
          repository: repo.url,
          error: resp.error || resp.body || `create-pr returned status ${resp.statusCode}`,
          ...(Array.isArray(resp.unmergedBranches) && resp.unmergedBranches.length
            ? { unmergedBranches: resp.unmergedBranches }
            : {}),
        });
        console.error(`[trigger_pr_creation] No PR created for ${repo.url}:`, resp);
      }
    } catch (e) {
      // Contain per-repo failures (malformed URL, Lambda invoke errors,
      // unparseable payloads). One bad repos[] entry must not brick PR
      // creation for the whole project.
      failedRepos.push({ repository: repo.url, error: e.message });
      console.error(`[trigger_pr_creation] PR creation threw for ${repo.url}:`, e);
    }
  }

  return { prResults, failedRepos, skippedRepos };
}

// Pure completeness check for the existing-PRGroup early-return: which
// configured repos have no live PR in the group? Without this, a re-run after
// a partial failure finds the (incomplete) PRGroup, sees its PRs are open, and
// early-returns success — permanently dropping the failed repos.
//
// A repo skipped on a previous run (no changes — see skippedRepos above) also
// has no PR in the group, so it shows up here as "missing" and is re-processed
// on every run. That is intentional: create-pr re-checks it cheaply and
// re-skips it (it never enters failedRepos or sets partialFailure), and if a
// later run DOES land commits on that repo, its PR is created and joins the
// group. Excluding skipped repos from the expected set would permanently mask
// late-arriving changes.
function missingRepos(gitRepos, existingPrs) {
  const covered = new Set((existingPrs || []).map((p) => p.repository));
  return (gitRepos || []).filter((r) => !covered.has(r.url));
}

module.exports = { createPrsForRepos, missingRepos };
