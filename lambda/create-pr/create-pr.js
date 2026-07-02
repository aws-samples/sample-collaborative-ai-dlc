// create-pr Lambda — opens a PR/MR for a completed construction sprint.
//
// All provider-specific logic (GitHub PRs vs GitLab MRs, the unmerged
// construction-task-branch guard, existing-PR lookup, no-change skip, and task
// branch cleanup) lives in shared/git-providers. This handler is a thin
// adapter: it validates input, picks the provider by `gitProvider`, and maps
// the provider's normalized result back to the caller.

const { getProvider } = require('../shared/git-providers');

exports.handler = async (event) => {
  const { projectId, branch, baseBranch, gitRepo, gitToken, executionId, title, gitProvider } =
    event;
  console.log(
    'Request:',
    JSON.stringify({ projectId, branch, baseBranch, gitRepo, executionId, gitProvider }),
  );

  if (!gitRepo || !branch || !gitToken) {
    return { statusCode: 400, body: 'Missing required parameters' };
  }

  let provider;
  try {
    provider = getProvider(gitProvider);
  } catch (err) {
    return { statusCode: 400, body: err.message };
  }

  const prTitle = title || `AI-DLC: ${branch}`;
  const prBody = `Automated ${provider.id === 'gitlab' ? 'MR' : 'PR'} created by AI-DLC Construction Agent\n\nExecution ID: ${executionId}\nProject: ${projectId}`;

  try {
    const result = await provider.createPullRequest({ token: gitToken }, gitRepo, {
      branch,
      baseBranch,
      title: prTitle,
      body: prBody,
    });

    // Unmerged construction task branches — surface as a 409 the orchestrator
    // recognises (it will server-side merge them and retry).
    if (result.conflict) {
      return { statusCode: 409, error: result.error, unmergedBranches: result.unmergedBranches };
    }
    if (result.skipped) {
      console.log(`No changes on ${branch} for ${gitRepo} — skipping PR/MR creation`);
      return { statusCode: 200, skipped: true, reason: result.reason || 'no_changes' };
    }
    if (result.existing) {
      console.log('Found existing PR/MR:', result.prUrl);
    } else {
      console.log('PR/MR created:', result.prUrl);
    }
    return {
      statusCode: 200,
      prUrl: result.prUrl,
      prNumber: result.prNumber,
      ...(result.existing ? { existing: true } : {}),
    };
  } catch (err) {
    // Malformed repo reference (and other client-side provider validation)
    // surfaces as a ProviderError with a 4xx status — preserve it as a 400 with
    // the message in `body`, matching the historical create-pr contract.
    if (err.name === 'ProviderError') {
      return { statusCode: err.status || 400, body: err.message };
    }
    console.error('Error creating PR/MR:', err);
    return { statusCode: 500, error: err.message };
  }
};
