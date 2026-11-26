import { gitlabInstanceSecrets } from '../../shared/git-providers/gitlab-instance.js';
import { provider as githubIssuesProvider } from './github-issues.js';
import { provider as gitlabIssuesProvider } from './gitlab-issues.js';
import { provider as jiraCloudProvider } from './jira-cloud.js';
import { ProviderError } from './errors.js';

const REGISTRY = {
  'github-issues': {
    instances: ['public'],
    provider: githubIssuesProvider,
  },
  'gitlab-issues': {
    instances: ['public'],
    provider: gitlabIssuesProvider,
  },
  'jira-cloud': {
    instances: ['cloud'],
    provider: jiraCloudProvider,
  },
};

export const KNOWN_PROVIDERS = Object.keys(REGISTRY);

export const getProvider = (providerId, instance) => {
  const entry = REGISTRY[providerId];
  if (!entry) {
    throw new ProviderError(400, `Unknown tracker provider: ${providerId}`);
  }
  const registeredGitlab =
    providerId === 'gitlab-issues' && Object.hasOwn(gitlabInstanceSecrets(), instance);
  if (instance && !entry.instances.includes(instance) && !registeredGitlab) {
    throw new ProviderError(400, `Unknown instance "${instance}" for provider ${providerId}`);
  }
  return entry.provider;
};

export { ProviderError };
