import { provider as githubIssuesProvider, ProviderError } from './github-issues.js';

const REGISTRY = {
  'github-issues': {
    instances: ['public'],
    provider: githubIssuesProvider,
  },
};

export const KNOWN_PROVIDERS = Object.keys(REGISTRY);

export const getProvider = (providerId, instance) => {
  const entry = REGISTRY[providerId];
  if (!entry) {
    throw new ProviderError(400, `Unknown tracker provider: ${providerId}`);
  }
  if (instance && !entry.instances.includes(instance)) {
    throw new ProviderError(400, `Unknown instance "${instance}" for provider ${providerId}`);
  }
  return entry.provider;
};

export { ProviderError };
