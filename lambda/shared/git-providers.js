'use strict';

// Unified git-provider registry — single source of truth for everything that
// varies between GitHub and GitLab. Adding a third provider (e.g. Bitbucket)
// means dropping one file in ./git-providers/ and registering it here; no
// caller needs to learn provider-specific hosts, auth schemes, or REST shapes.
//
// Why CJS + a top-level file (not git-providers/index.js): the agents-ecs
// container build copies individual `shared/<file>.js` into the image (it does
// NOT mount lambda/shared wholesale), and the pool-worker packaging test only
// recognises `require('../shared/<name>')`. Keeping this entry point as a
// single top-level file lets the Dockerfile copy it (plus the ./git-providers/
// implementation files) without changing the established pattern.
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

const github = require('./git-providers/github');
const gitlab = require('./git-providers/gitlab');
const bitbucket = require('./git-providers/bitbucket');
const { ProviderError } = require('./git-providers/errors');

const REGISTRY = { github, gitlab, bitbucket };

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

// Convenience helpers for the construction runtime (pool-worker, prompts) that
// only need the host/clone plumbing, not the full REST surface.
const gitHost = (providerId) => getProvider(providerId).gitHost;
const buildCloneUrl = (providerId, repoId, token) =>
  getProvider(providerId).buildCloneUrl(repoId, token);

module.exports = {
  ProviderError,
  KNOWN_PROVIDERS: Object.keys(REGISTRY),
  DEFAULT_PROVIDER,
  normalizeProviderId,
  isKnownProvider,
  getProvider,
  gitHost,
  buildCloneUrl,
};
