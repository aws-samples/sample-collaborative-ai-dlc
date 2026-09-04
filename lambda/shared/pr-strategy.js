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

export {
  PR_STRATEGIES,
  PROJECT_PR_STRATEGIES,
  DEFAULT_PR_STRATEGY,
  normalizePlatformPrStrategy,
  normalizeProjectPrStrategy,
  effectivePrStrategy,
};

export default {
  PR_STRATEGIES,
  PROJECT_PR_STRATEGIES,
  DEFAULT_PR_STRATEGY,
  normalizePlatformPrStrategy,
  normalizeProjectPrStrategy,
  effectivePrStrategy,
};
