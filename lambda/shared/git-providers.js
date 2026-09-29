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
//   buildCloneUrl(repoId, token)        -> tokenized https clone URL
//   oauth: { secretEnvName, redirectUriEnvName, scopes,
//            buildAuthorizeUrl({clientId, redirectUri, state}),
//            exchangeCode({clientId, clientSecret, code, redirectUri?}),
//            refreshAccessToken?({clientId, clientSecret, refreshToken}) }
//   listRepos(ctx)                      -> GitRepo[]
//   listBranches(ctx, repoId)           -> string[]
//   getTree(ctx, repoId, branch)        -> GitFile[]
//   getFileContents(ctx, repoId, path, branch) -> GitFileContent
//   findPullRequest(ctx, repoId, {sourceBranch,targetBranch,state}) -> provider PR | null
//   createPullRequest(ctx, repoId, {...,draft?}) -> created/existing PR summary
//   getPullRequestStatus(ctx, repoId, prRef) -> normalized live status
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

const REGISTRY = { github, gitlab, bitbucket, codecommit };

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
  if (provider.gitHost) return provider.gitHost;
  if (repoId && typeof provider.gitHostFor === 'function') return provider.gitHostFor(repoId);
  return null;
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
