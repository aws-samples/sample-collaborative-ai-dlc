// Delete an intent's branches from a repository the intent never changed.
// Runs inside the source-control service beside the provider adapters, like
// inspectDelivery. The family is the intent branch plus every branch derived
// from it (`<branch>--…`: unit lanes and construction tasks). It is deleted
// only as a whole, and only when no branch in it carries a commit the base
// branch lacks or is the source of an open pull request. A repository with any
// work keeps every branch, so a rewind or a delivery retry finds what it left.
// Deletion failures are reported per branch and never thrown: a refused delete
// (for example a protected branch) is not a credential failure.
import { ProviderError } from './git-providers/errors.js';

const KEEP = Object.freeze({
  BASE: 'base_branch',
  COMMITS: 'has_commits',
  OPEN_PR: 'open_pull_request',
  CHANGED: 'branch_changed',
  FAMILY: 'family_has_work',
  DELETE_FAILED: 'delete_failed',
});

export const deleteUnusedBranches = async (provider, ctx, repo, { branch, baseBranch } = {}) => {
  if (typeof branch !== 'string' || !branch.trim())
    throw new ProviderError(400, 'A branch is required');
  const defaultBranch = await provider.getDefaultBranch(ctx, repo);
  const base = baseBranch || defaultBranch;
  if (!base) throw new ProviderError(409, 'The base branch is unknown');

  const children = await provider.listBranchesWithPrefix(ctx, repo, `${branch}--`);
  // Children first, so the intent branch is the last to go: an interrupted
  // cleanup never leaves unit branches without the branch they merge into.
  const family = [...new Set(children), branch];
  if (family.some((name) => name === base || name === defaultBranch))
    return { baseBranch: base, deleted: [], kept: [{ branch, reason: KEEP.BASE }] };

  const heads = new Map();
  const kept = [];
  for (const name of family) {
    const head = await provider.getBranchHead(ctx, repo, name);
    if (!head) continue; // already gone
    if (!(await provider.isCommitAncestor(ctx, repo, head, base))) {
      kept.push({ branch: name, reason: KEEP.COMMITS });
      continue;
    }
    const prs = await provider.listPullRequests(ctx, repo, {
      sourceBranch: name,
      includeTerminal: false,
    });
    if (prs.some((pr) => pr.state === 'open')) {
      kept.push({ branch: name, reason: KEEP.OPEN_PR });
      continue;
    }
    heads.set(name, head);
  }
  if (kept.length)
    return {
      baseBranch: base,
      deleted: [],
      kept: [...kept, ...[...heads.keys()].map((name) => ({ branch: name, reason: KEEP.FAMILY }))],
    };

  const deleted = [];
  for (const [name, head] of heads) {
    try {
      // The provider APIs cannot delete conditionally; re-read the head so a
      // push since the checks above keeps the branch.
      const current = await provider.getBranchHead(ctx, repo, name);
      if (!current) continue;
      if (current !== head) {
        kept.push({ branch: name, reason: KEEP.CHANGED });
        break;
      }
      await provider.deleteBranch(ctx, repo, name);
      deleted.push(name);
    } catch {
      kept.push({ branch: name, reason: KEEP.DELETE_FAILED });
      break;
    }
  }
  // Stop at the first branch kept: the rest, including the intent branch,
  // stay for the next cleanup or for a relaunch to reuse.
  const remaining = [...heads.keys()].filter(
    (name) => !deleted.includes(name) && !kept.some((k) => k.branch === name),
  );
  return {
    baseBranch: base,
    deleted,
    kept: [...kept, ...remaining.map((name) => ({ branch: name, reason: KEEP.FAMILY }))],
  };
};
