// Whether a merged unit PR delivered the head that was accepted for it.
//
// A merge commit keeps the accepted head itself on the target branch. A squash
// or rebase merge writes new commits instead, so the accepted head never
// becomes an ancestor of the target. For those, the provider's merge result
// (the merge, squash or rebased head commit) must be on the target, and the PR
// must still point at the accepted head, so a push after acceptance can't
// count as delivered.
//
// `isAncestor(sha, ref)` asks the provider; its errors propagate to the caller.
export const mergedUnitPrDelivered = async ({ acceptedHeadSha, status, targetRef, isAncestor }) => {
  if (!acceptedHeadSha || status?.state !== 'merged') return false;
  if (await isAncestor(acceptedHeadSha, targetRef)) return true;
  if (!status.mergeResultSha || status.headSha !== acceptedHeadSha) return false;
  return Boolean(await isAncestor(status.mergeResultSha, targetRef));
};
