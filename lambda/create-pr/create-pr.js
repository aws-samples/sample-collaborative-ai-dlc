function encodeRefPath(ref) {
  return ref.split('/').map(encodeURIComponent).join('/');
}

function getConstructionBranchCleanupPrefix(branch) {
  return `refs/heads/${branch}--task-`;
}

function getBranchNameFromRef(refName) {
  return refName.replace(/^refs\/heads\//, '');
}

async function listConstructionTaskRefs({ owner, repo, branch, ghHeaders, fetchImpl = fetch }) {
  const refPrefix = getConstructionBranchCleanupPrefix(branch);
  const matchingRefsPath = encodeRefPath(`heads/${branch}--task-`);
  const refsRes = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/git/matching-refs/${matchingRefsPath}`,
    { headers: ghHeaders },
  );

  if (!refsRes.ok) {
    const errorText = await refsRes.text();
    throw new Error(`Failed to list construction task branches: ${errorText}`);
  }

  const refs = await refsRes.json();
  return refs.filter((ref) => ref?.ref?.startsWith(refPrefix));
}

async function isBranchMergedInto({
  owner,
  repo,
  sourceBranch,
  targetBranch,
  ghHeaders,
  fetchImpl,
}) {
  const compareRes = await fetchImpl(
    `https://api.github.com/repos/${owner}/${repo}/compare/${encodeURIComponent(sourceBranch)}...${encodeURIComponent(targetBranch)}`,
    { headers: ghHeaders },
  );
  if (!compareRes.ok) {
    const errorText = await compareRes.text();
    throw new Error(`Failed to compare ${sourceBranch} against ${targetBranch}: ${errorText}`);
  }

  const comparison = await compareRes.json();
  return comparison.status === 'identical' || comparison.status === 'ahead';
}

async function getUnmergedConstructionTaskBranches({
  owner,
  repo,
  branch,
  ghHeaders,
  fetchImpl = fetch,
}) {
  const refs = await listConstructionTaskRefs({ owner, repo, branch, ghHeaders, fetchImpl });
  const unmerged = [];

  for (const ref of refs) {
    const taskBranch = getBranchNameFromRef(ref.ref);
    const merged = await isBranchMergedInto({
      owner,
      repo,
      sourceBranch: taskBranch,
      targetBranch: branch,
      ghHeaders,
      fetchImpl,
    });
    if (!merged) unmerged.push(taskBranch);
  }

  return unmerged;
}

async function cleanupConstructionTaskBranches({
  owner,
  repo,
  branch,
  ghHeaders,
  fetchImpl = fetch,
}) {
  let refs;
  try {
    refs = await listConstructionTaskRefs({ owner, repo, branch, ghHeaders, fetchImpl });
  } catch (err) {
    console.error(err.message);
    return { deleted: 0, failed: 1, skipped: 0 };
  }

  let deleted = 0;
  let failed = 0;
  let skipped = 0;

  for (const ref of refs) {
    const refName = ref.ref;
    const taskBranch = getBranchNameFromRef(refName);
    let merged = false;
    try {
      merged = await isBranchMergedInto({
        owner,
        repo,
        sourceBranch: taskBranch,
        targetBranch: branch,
        ghHeaders,
        fetchImpl,
      });
    } catch (err) {
      failed += 1;
      console.error(err.message);
      continue;
    }

    if (!merged) {
      skipped += 1;
      console.error(`Skipping unmerged construction task branch ${taskBranch}`);
      continue;
    }

    const deletePath = encodeRefPath(refName.replace(/^refs\//, ''));
    const deleteRes = await fetchImpl(
      `https://api.github.com/repos/${owner}/${repo}/git/refs/${deletePath}`,
      { method: 'DELETE', headers: ghHeaders },
    );

    if (deleteRes.ok) {
      deleted += 1;
    } else {
      failed += 1;
      const errorText = await deleteRes.text();
      console.error(`Failed to delete construction task branch ${refName}:`, errorText);
    }
  }

  if (deleted || failed || skipped) {
    console.log(
      `Construction task branch cleanup complete: deleted=${deleted}, failed=${failed}, skipped=${skipped}`,
    );
  }
  return { deleted, failed, skipped };
}

// A 422 from POST /pulls is benign when the sprint simply produced no changes
// for this repository (normal in multi-repo projects where a sprint only
// touches a subset of repos):
//   (a) the branch exists but is identical to base — GitHub says
//       "No commits between <base> and <head>"
//   (b) the head branch was never pushed (the pool-worker skips empty repos
//       with reason 'no_commits') — GitHub reports the head as invalid, either
//       as {"field":"head","code":"invalid"} or the older custom message
//       "head sha can't be blank"
// Any other 422 (invalid base, validation failures, ...) is a real error and
// must keep throwing.
function isNoChanges422(errorText) {
  const text = (errorText || '').toLowerCase();
  if (text.includes('no commits between')) return true;
  if (/head sha can't be blank|head ref.*(does not|doesn't) exist/.test(text)) return true;
  // Structured variant: {"errors":[{"resource":"PullRequest","field":"head","code":"invalid"}]}
  // — parsed instead of substring-matched so a "field":"base" error never matches.
  try {
    const body = JSON.parse(errorText);
    const errors = Array.isArray(body?.errors) ? body.errors : [];
    return errors.some((e) => e?.field === 'head' && e?.code === 'invalid');
  } catch {
    return false;
  }
}

exports.handler = async (event) => {
  const { projectId, branch, baseBranch, gitRepo, gitToken, executionId, title } = event;
  console.log('Request:', JSON.stringify({ projectId, branch, baseBranch, gitRepo, executionId }));

  if (!gitRepo || !branch || !gitToken) {
    return { statusCode: 400, body: 'Missing required parameters' };
  }

  try {
    // Get project details from Neptune via GitHub Lambda
    const parts = gitRepo.split('/');
    if (parts.length !== 2 || !parts[0] || !parts[1]) {
      return { statusCode: 400, body: `Invalid gitRepo "${gitRepo}": expected "owner/repo"` };
    }
    const [owner, repo] = parts;

    // Create PR using GitHub API
    const prTitle = title || `AI-DLC: ${branch}`;
    const prBody = `Automated PR created by AI-DLC Construction Agent\n\nExecution ID: ${executionId}\nProject: ${projectId}`;

    const ghHeaders = {
      Authorization: `token ${gitToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

    const unmergedBranches = await getUnmergedConstructionTaskBranches({
      owner,
      repo,
      branch,
      ghHeaders,
    });
    if (unmergedBranches.length) {
      return {
        statusCode: 409,
        error: `Cannot create PR: ${unmergedBranches.length} construction task branch(es) are not merged into ${branch}`,
        unmergedBranches,
      };
    }

    const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls`, {
      method: 'POST',
      headers: ghHeaders,
      body: JSON.stringify({
        title: prTitle,
        body: prBody,
        head: branch,
        base: baseBranch || 'main',
      }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      // 422 means a PR already exists for this branch — look it up and return it
      if (response.status === 422) {
        console.log(`PR already exists for branch ${branch}, fetching existing PR...`);
        // The head filter `${owner}:${branch}` assumes the PR's head branch lives
        // in the SAME owner as the base repo. That holds for our same-repo flow but
        // is brittle for fork/org-mismatch setups (head would be `forkOwner:branch`).
        // So we try the precise head filter first, then fall back to listing PRs and
        // matching on the branch ref (head.ref) regardless of head owner.
        const findByBranch = async (state) => {
          // Precise: owner-qualified head filter.
          const headRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=${state}`,
            { headers: ghHeaders },
          );
          if (headRes.ok) {
            const headPrs = await headRes.json();
            if (headPrs.length > 0) return headPrs[0];
          }
          // Fallback: list PRs and match on the branch ref (handles fork/org mismatch).
          const listRes = await fetch(
            `https://api.github.com/repos/${owner}/${repo}/pulls?state=${state}&per_page=100`,
            { headers: ghHeaders },
          );
          if (listRes.ok) {
            const prs = await listRes.json();
            const match = prs.find((p) => p.head?.ref === branch);
            if (match) return match;
          }
          return null;
        };

        const openPr = await findByBranch('open');
        if (openPr) {
          console.log('Found existing PR:', openPr.html_url);
          await cleanupConstructionTaskBranches({ owner, repo, branch, ghHeaders });
          return {
            statusCode: 200,
            prUrl: openPr.html_url,
            prNumber: openPr.number,
            existing: true,
          };
        }
        // PR is closed/merged — check all states too
        const anyPr = await findByBranch('all');
        if (anyPr) {
          console.log('Found existing (closed) PR:', anyPr.html_url);
          await cleanupConstructionTaskBranches({ owner, repo, branch, ghHeaders });
          return {
            statusCode: 200,
            prUrl: anyPr.html_url,
            prNumber: anyPr.number,
            existing: true,
          };
        }
        // No PR exists for this branch in any state. If the 422 only says the
        // sprint produced no changes for this repo, report "skipped" instead
        // of failing — the orchestrator must not page a human for it.
        if (isNoChanges422(errorText)) {
          console.log(`No changes on ${branch} for ${owner}/${repo} — skipping PR creation`);
          return { statusCode: 200, skipped: true, reason: 'no_changes' };
        }
      }
      console.error('GitHub API error:', errorText);
      throw new Error(`Failed to create PR: ${response.status} ${errorText}`); // nosemgrep: tainted-sql-string
    }

    const pr = await response.json();
    console.log('PR created:', pr.html_url);
    await cleanupConstructionTaskBranches({ owner, repo, branch, ghHeaders });

    return {
      statusCode: 200,
      prUrl: pr.html_url,
      prNumber: pr.number,
    };
  } catch (err) {
    console.error('Error creating PR:', err);
    return {
      statusCode: 500,
      error: err.message,
    };
  }
};

exports.cleanupConstructionTaskBranches = cleanupConstructionTaskBranches;
exports.getUnmergedConstructionTaskBranches = getUnmergedConstructionTaskBranches;
exports.getConstructionBranchCleanupPrefix = getConstructionBranchCleanupPrefix;
