// Strict publication reads live beside the provider adapters. No credentials or
// provider response bodies cross this boundary: a pull request description is
// reduced to the delivery markers it carries.
import { ProviderError } from './git-providers/errors.js';
import { deliveryMarkers } from './delivery-marker.js';

// Every pull request from the intent branch, in every state and from every
// page. Final delivery decides ownership over the complete set
// (selectDeliveryPr in final-delivery.js); nothing here picks or rejects a
// first match.
export const inspectDelivery = async (provider, ctx, repo, { branch, baseBranch }) => {
  const base = baseBranch || (await provider.getDefaultBranch(ctx, repo));
  if (!base) throw new ProviderError(409, 'The delivery base branch is unknown');
  const listed = await provider.listPullRequests(ctx, repo, { sourceBranch: branch });
  const pullRequests = listed.map(({ body, ...pr }) => ({
    ...pr,
    markers: deliveryMarkers(body),
  }));
  const headSha = await provider.getBranchHead(ctx, repo, branch);
  const baseSha = await provider.getBranchHead(ctx, repo, base);
  return { baseBranch: base, headSha, baseSha, pullRequests };
};
