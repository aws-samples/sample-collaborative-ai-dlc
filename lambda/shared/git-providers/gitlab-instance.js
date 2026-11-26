import { Logger } from '@aws-lambda-powertools/logger';
import { ProviderError } from './errors.js';
import { validInstance } from '../gitlab-instance.js';

const logger = new Logger({ persistentKeys: { component: 'gitlab-transport' } });

export const gitlabInstanceSecrets = () => JSON.parse(process.env.GITLAB_INSTANCE_SECRETS || '{}');
export const gitlabSecretName = (instance) => {
  if (instance === undefined) return process.env.GITLAB_OAUTH_SECRET_NAME;
  const registry = gitlabInstanceSecrets();
  if (!validInstance(instance) || !Object.hasOwn(registry, instance)) {
    throw new ProviderError(400, 'Unregistered GitLab instance');
  }
  return registry[instance];
};

// OAuth exchanges carry the application secret. Never follow a redirect with
// credentials; an identity proxy commonly redirects unattended clients to SSO.
export const gitlabFetch = async (fetchImpl, url, options, instance) => {
  if (!instance) return fetchImpl(url, options);
  let response;
  try {
    response = await fetchImpl(url, { ...options, redirect: 'manual' });
  } catch (error) {
    if (options.signal?.aborted || error?.name === 'AbortError' || error?.name === 'TimeoutError') {
      throw error;
    }
    const cause = error?.cause?.code ?? error?.name ?? 'UnknownError';
    logger.warn('Could not reach GitLab', { instance, cause });
    throw new ProviderError(502, 'Could not reach GitLab. Check DNS, routing and TLS trust.', {
      code: 'GITLAB_UNREACHABLE',
      cause,
    });
  }
  // Attachment downloads handle manual redirects themselves.
  if (options.redirect === 'manual') return response;
  if (
    (response.status >= 300 && response.status < 400) ||
    response.headers?.get?.('content-type')?.includes('text/html')
  ) {
    throw new ProviderError(
      502,
      'GitLab returned a redirect or login page. The endpoint must accept unattended HTTPS requests.',
      { code: 'GITLAB_INTERACTIVE_LOGIN' },
    );
  }
  return response;
};
