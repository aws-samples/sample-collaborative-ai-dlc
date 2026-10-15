// Strict publication reads live beside the provider adapters. No credentials or
// provider response bodies cross this boundary.
import { ProviderError } from './git-providers/errors.js';

export const inspectDelivery = async (provider, ctx, repo, { branch, baseBranch, number }) => {
  const base = baseBranch || (await provider.getDefaultBranch(ctx, repo));
  if (!base) throw new ProviderError(409, 'The delivery base branch is unknown');
  let pr = null;
  if (number != null) {
    pr = await provider.getPullRequestStatus(ctx, repo, number);
    if (!pr) throw new ProviderError(409, 'The recorded pull request could not be verified');
  } else {
    const states =
      provider.id === 'bitbucket' ? ['OPEN', 'MERGED', 'DECLINED', 'SUPERSEDED'] : ['all'];
    for (const state of states) {
      const found = await provider.findPullRequest(ctx, repo, {
        sourceBranch: branch,
        targetBranch: null,
        state,
        strict: true,
      });
      if (!found) continue;
      const ref = found.number ?? found.iid ?? found.pullRequestId ?? found.id;
      pr = await provider.getPullRequestStatus(ctx, repo, ref);
      if (!pr) throw new ProviderError(409, 'The matching pull request could not be verified');
      break;
    }
  }
  const headSha = await provider.getBranchHead(ctx, repo, branch);
  const baseSha = await provider.getBranchHead(ctx, repo, base);
  return { baseBranch: base, headSha, baseSha, pr };
};
