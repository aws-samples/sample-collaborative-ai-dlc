// Unified git-provider registry — single source of truth for everything that
// varies between GitHub and GitLab. Adding a third provider (e.g. Bitbucket)
// means dropping one file in ./git-providers/ and registering it here; no
// caller needs to learn provider-specific hosts, auth schemes, or REST shapes.
//
// Why a top-level file (not git-providers/index.js): keeping this entry point as
// a single top-level module preserves the established `../shared/<name>` import
// pattern across lambdas and the AgentCore image.
//
// Provider contract (each implementation exports):
//   id, displayName, gitHost, apiBase
//   instanceFor(repoId)                 -> self-managed instance or undefined
//   repoPathFor(repoId)                  -> repository path within its instance
//   listInstances?()                    -> registered self-managed hosts (defaults to [])
//   buildCloneUrl(repoId, token)        -> tokenized https clone URL
//   oauth: { secretEnvName, redirectUriEnvName, scopes,
//            buildAuthorizeUrl({clientId, redirectUri, state}),
//            exchangeCode({clientId, clientSecret, code, redirectUri?}),
//            refreshAccessToken?({clientId, clientSecret, refreshToken}) }
//   oauth.secretNameFor?(instance)      -> OAuth secret name (defaults to process.env[oauth.secretEnvName])
//   listRepos(ctx)                      -> GitRepo[]
//   listBranches(ctx, repoId)           -> string[]
//   listReposPage?(ctx, page), listBranchesPage?(ctx, repoId, page) and
//   listIssueCommentsPage?(ctx, repoId, issue, page) -> one provider page,
//       { repos | branches | comments, nextPage: number | null }, for callers
//       behind a request deadline; implemented where a list has more pages
//       than one call reads (GitHub)
//   getTree(ctx, repoId, branch)        -> GitFile[]
//   getFileContents(ctx, repoId, path, branch) -> GitFileContent
//   findPullRequest(ctx, repoId, {sourceBranch,targetBranch,state}) -> provider PR | null
//   listPullRequests(ctx, repoId, {sourceBranch}) -> every PR from the branch, all
//       states and pages: [{number,url,state,sourceBranch,targetBranch,headSha,body}];
//       throws instead of returning a partial list
//   getBranchHead(ctx, repoId, branch)  -> head SHA | null
//   listBranchesWithPrefix(ctx, repoId, prefix) -> every branch name starting
//       with prefix; throws instead of returning a partial list
//   deleteBranch(ctx, repoId, branch)   -> true | false when already gone
//   createPullRequest(ctx, repoId, {...,draft?}) -> created/existing PR summary
//   getPullRequestStatus(ctx, repoId, prRef) -> normalized live status;
//       mergeResultSha is the commit a merged PR left on its target (merge,
//       squash or rebased head commit), null until it merges
//   setPullRequestDraft(ctx, repoId, prRef, draft) -> normalized live status
//   reopenPullRequest(ctx, repoId, prRef) -> normalized live status
//   isCommitAncestor(ctx, repoId, ancestorSha, descendantRef) -> boolean
//   listPRComments(ctx, repoId, prRef)  -> paginated GitComment[]
//   addPRComment(ctx, repoId, prRef, {body, path?, line?, side?}) -> GitComment
// where ctx = { token, fetchImpl?, onRefresh? }.

import github from './git-providers/github.js';
import gitlab from './git-providers/gitlab.js';
import bitbucket from './git-providers/bitbucket.js';
import codecommit from './git-providers/codecommit.js';
import { ProviderError } from './git-providers/errors.js';

const REGISTRY = Object.fromEntries(
  [github, gitlab, bitbucket, codecommit].map((provider) => [
    provider.id,
    { instanceFor: () => undefined, repoPathFor: (repo) => repo, ...provider },
  ]),
);

// Every provider declares the contract gaps it cannot honour so callers can
// branch BEFORE invoking a method that can only throw. Missing keys read as
// "supported" -- the historical default for the three OAuth providers.
const DEFAULT_CAPABILITIES = Object.freeze({
  issues: true,
  draftPullRequests: true,
  reopenPullRequest: true,
  checkStatuses: true,
  approvalRules: false,
  events: 'webhook',
});

const getCapabilities = (providerId) => ({
  ...DEFAULT_CAPABILITIES,
  ...getProvider(providerId).capabilities,
});

const DEFAULT_PROVIDER = 'github';

// Normalise an incoming provider id; defaults to github for legacy/undefined.
const normalizeProviderId = (providerId) => providerId || DEFAULT_PROVIDER;

const isKnownProvider = (providerId) =>
  Object.prototype.hasOwnProperty.call(REGISTRY, normalizeProviderId(providerId));

const getProvider = (providerId) => {
  const key = normalizeProviderId(providerId);
  const provider = REGISTRY[key];
  if (!provider) {
    throw new ProviderError(400, `Unknown git provider: ${providerId}`);
  }
  return provider;
};

// Convenience helpers for callers (e.g. the agentcore workspace) that only
// need the host/clone plumbing, not the full REST surface.
// Regional providers (CodeCommit) have no single host; pass the repoId to
// resolve it, otherwise the provider-wide constant is returned.
const gitHost = (providerId, repoId) => {
  const provider = getProvider(providerId);
  if (repoId && typeof provider.gitHostFor === 'function') return provider.gitHostFor(repoId);
  return provider.gitHost ?? null;
};
const buildCloneUrl = (providerId, repoId, token) =>
  getProvider(providerId).buildCloneUrl(repoId, token);

const KNOWN_PROVIDERS = Object.keys(REGISTRY);
export {
  ProviderError,
  KNOWN_PROVIDERS,
  DEFAULT_PROVIDER,
  normalizeProviderId,
  isKnownProvider,
  getProvider,
  getCapabilities,
  DEFAULT_CAPABILITIES,
  gitHost,
  buildCloneUrl,
};
export default {
  ProviderError,
  KNOWN_PROVIDERS,
  DEFAULT_PROVIDER,
  normalizeProviderId,
  isKnownProvider,
  getProvider,
  getCapabilities,
  DEFAULT_CAPABILITIES,
  gitHost,
  buildCloneUrl,
};
