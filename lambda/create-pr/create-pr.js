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

exports.handler = async (event) => {
  const { projectId, branch, baseBranch, gitRepo, gitToken, executionId } = event;
  console.log('Request:', JSON.stringify({ projectId, branch, baseBranch, gitRepo, executionId }));

  if (!gitRepo || !branch || !gitToken) {
    return { statusCode: 400, body: 'Missing required parameters' };
  }

  try {
    // Get project details from Neptune via GitHub Lambda
    const [owner, repo] = gitRepo.split('/');

    // Create PR using GitHub API
    const prTitle = `AI-DLC: ${branch}`;
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
        const listRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
          { headers: ghHeaders },
        );
        if (listRes.ok) {
          const prs = await listRes.json();
          if (prs.length > 0) {
            console.log('Found existing PR:', prs[0].html_url);
            await cleanupConstructionTaskBranches({ owner, repo, branch, ghHeaders });
            return {
              statusCode: 200,
              prUrl: prs[0].html_url,
              prNumber: prs[0].number,
              existing: true,
            };
          }
        }
        // PR is closed/merged — check closed PRs too
        const closedRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=all`,
          { headers: ghHeaders },
        );
        if (closedRes.ok) {
          const allPrs = await closedRes.json();
          if (allPrs.length > 0) {
            console.log('Found existing (closed) PR:', allPrs[0].html_url);
            await cleanupConstructionTaskBranches({ owner, repo, branch, ghHeaders });
            return {
              statusCode: 200,
              prUrl: allPrs[0].html_url,
              prNumber: allPrs[0].number,
              existing: true,
            };
          }
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
