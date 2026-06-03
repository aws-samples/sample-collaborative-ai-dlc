exports.handler = async (event) => {
  const { projectId, branch, baseBranch, gitRepo, gitToken, executionId } = event;
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
    const prTitle = `AI-DLC: ${branch}`;
    const prBody = `Automated PR created by AI-DLC Construction Agent\n\nExecution ID: ${executionId}\nProject: ${projectId}`;

    const ghHeaders = {
      Authorization: `token ${gitToken}`,
      Accept: 'application/vnd.github.v3+json',
      'Content-Type': 'application/json',
    };

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
          return {
            statusCode: 200,
            prUrl: anyPr.html_url,
            prNumber: anyPr.number,
            existing: true,
          };
        }
      }
      console.error('GitHub API error:', errorText);
      throw new Error(`Failed to create PR: ${response.status} ${errorText}`); // nosemgrep: tainted-sql-string
    }

    const pr = await response.json();
    console.log('PR created:', pr.html_url);

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
