// Pull-request delivery strategy shared by platform settings, projects, and
// intent creation. Projects store an override; executions store the resolved
// value so a platform setting change never alters an in-flight intent.

const PR_STRATEGIES = ['intent-pr', 'pr-per-unit'];
const PROJECT_PR_STRATEGIES = ['default', ...PR_STRATEGIES];
const DEFAULT_PR_STRATEGY = 'intent-pr';

const normalizePlatformPrStrategy = (value) =>
  PR_STRATEGIES.includes(value) ? value : DEFAULT_PR_STRATEGY;

const normalizeProjectPrStrategy = (value, { legacyDefault = false } = {}) => {
  if (value === undefined || value === null || value === '') {
    return legacyDefault ? DEFAULT_PR_STRATEGY : 'default';
  }
  return PROJECT_PR_STRATEGIES.includes(value) ? value : null;
};

const effectivePrStrategy = (platformValue, projectValue = 'default') => {
  if (PR_STRATEGIES.includes(projectValue)) return projectValue;
  return normalizePlatformPrStrategy(platformValue);
};

// Providers whose pull requests have no draft state. pr-per-unit (and the
// feedback revisions it hosts) parks each unit PR as a draft while its lane
// waits, reconciles or rewrites the head, so the PR cannot be merged under it.
// Without drafts that safeguard cannot be enforced, so the strategy is refused
// for these providers before anything is dispatched. Kept equal to the
// providers declaring `capabilities.draftPullRequests: false` by test; a leaf
// list so the intents and orchestrator bundles stay free of provider SDKs.
const PROVIDERS_WITHOUT_DRAFT_PULL_REQUESTS = Object.freeze(['codecommit']);

const draftlessProviders = (providers = []) =>
  [...new Set(providers)].filter((provider) =>
    PROVIDERS_WITHOUT_DRAFT_PULL_REQUESTS.includes(provider),
  );

// Throws a typed 409 when `strategy` needs draft pull requests that one of
// the providers cannot give.
const assertPrStrategySupported = (strategy, providers = []) => {
  if (strategy !== 'pr-per-unit') return;
  const unsupported = draftlessProviders(providers);
  if (unsupported.length) {
    throw Object.assign(
      new Error(
        `PR per unit needs draft pull requests, which ${unsupported.join(', ')} does not support. Use one PR per intent for this space.`,
      ),
      { code: 'PR_STRATEGY_UNSUPPORTED', status: 409, providers: unsupported },
    );
  }
};

export {
  PR_STRATEGIES,
  PROJECT_PR_STRATEGIES,
  DEFAULT_PR_STRATEGY,
  normalizePlatformPrStrategy,
  normalizeProjectPrStrategy,
  effectivePrStrategy,
  PROVIDERS_WITHOUT_DRAFT_PULL_REQUESTS,
  draftlessProviders,
  assertPrStrategySupported,
};

export default {
  PR_STRATEGIES,
  PROJECT_PR_STRATEGIES,
  DEFAULT_PR_STRATEGY,
  normalizePlatformPrStrategy,
  normalizeProjectPrStrategy,
  effectivePrStrategy,
  PROVIDERS_WITHOUT_DRAFT_PULL_REQUESTS,
  draftlessProviders,
  assertPrStrategySupported,
};
