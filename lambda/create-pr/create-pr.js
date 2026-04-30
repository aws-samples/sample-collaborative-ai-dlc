const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const { DynamoDBDocumentClient, GetCommand } = require('@aws-sdk/lib-dynamodb');

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

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
      'Authorization': `token ${gitToken}`,
      'Accept': 'application/vnd.github.v3+json',
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
        const listRes = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls?head=${owner}:${branch}&state=open`,
          { headers: ghHeaders }
        );
        if (listRes.ok) {
          const prs = await listRes.json();
          if (prs.length > 0) {
            console.log('Found existing PR:', prs[0].html_url);
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
          { headers: ghHeaders }
        );
        if (closedRes.ok) {
          const allPrs = await closedRes.json();
          if (allPrs.length > 0) {
            console.log('Found existing (closed) PR:', allPrs[0].html_url);
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
