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
//   listPRComments(ctx, repoId, prRef)  -> GitComment[]
//   addPRComment(ctx, repoId, prRef, {body, path?, line?, side?}) -> GitComment
// where ctx = { token, fetchImpl?, onRefresh? }.

import github from './git-providers/github.js';
import gitlab from './git-providers/gitlab.js';
import { ProviderError } from './git-providers/errors.js';

const REGISTRY = { github, gitlab };

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
const gitHost = (providerId) => getProvider(providerId).gitHost;
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
  gitHost,
  buildCloneUrl,
};
