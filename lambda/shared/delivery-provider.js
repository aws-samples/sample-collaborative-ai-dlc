// Strict publication reads live beside the provider adapters. No credentials or
// provider response bodies cross this boundary.
import { ProviderError } from './git-providers/errors.js';

const OPEN_STATE = { gitlab: 'opened', bitbucket: 'OPEN' };
const TERMINAL_STATES = { bitbucket: ['MERGED', 'DECLINED', 'SUPERSEDED'] };
// Provider and Lambda clocks differ; earlier runs of the branch are far older.
const CREATED_CLOCK_SKEW_MS = 5 * 60_000;

const findStatus = async (provider, ctx, repo, branch, state) => {
  const found = await provider.findPullRequest(ctx, repo, {
    sourceBranch: branch,
    targetBranch: null,
    state,
    strict: true,
  });
  if (!found) return null;
  const ref = found.number ?? found.iid ?? found.pullRequestId ?? found.id;
  const pr = await provider.getPullRequestStatus(ctx, repo, ref);
  if (!pr) throw new ProviderError(409, 'The matching pull request could not be verified');
  return pr;
};

// The intent branch outlives a run: rewind and relaunch keep it. An open pull
// request is current. A closed or merged one belongs to this delivery only when
// this run requested creation (`createdAfter`) and the provider created it after
// that request — a lost create response followed by a close. Older terminal pull
// requests are an earlier run's history and never block a new publication.
export const inspectDelivery = async (
  provider,
  ctx,
  repo,
  { branch, baseBranch, number, createdAfter = null },
) => {
  const base = baseBranch || (await provider.getDefaultBranch(ctx, repo));
  if (!base) throw new ProviderError(409, 'The delivery base branch is unknown');
  let pr = null;
  if (number != null) {
    pr = await provider.getPullRequestStatus(ctx, repo, number);
    if (!pr) throw new ProviderError(409, 'The recorded pull request could not be verified');
  } else {
    pr = await findStatus(provider, ctx, repo, branch, OPEN_STATE[provider.id] ?? 'open');
    if (!pr && createdAfter) {
      const since = Date.parse(createdAfter) - CREATED_CLOCK_SKEW_MS;
      for (const state of TERMINAL_STATES[provider.id] ?? ['all']) {
        const found = await findStatus(provider, ctx, repo, branch, state);
        const created = Date.parse(found?.createdAt);
        if (found && (!Number.isFinite(created) || created >= since)) {
          pr = found;
          break;
        }
      }
    }
  }
  const headSha = await provider.getBranchHead(ctx, repo, branch);
  const baseSha = await provider.getBranchHead(ctx, repo, base);
  return { baseBranch: base, headSha, baseSha, pr };
};
