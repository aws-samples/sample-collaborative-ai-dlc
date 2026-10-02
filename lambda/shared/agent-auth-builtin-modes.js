import { authError } from './agent-auth-protocol.js';
import { defineAuthMode, normalizeConfigurationFields } from './agent-auth-mode-registry.js';

const normalizeRegionConfiguration = (configuration) =>
  normalizeConfigurationFields(configuration, { region: 'string' });

// Kiro keys are an uncatalogued pseudo-mode that stores the same configuration as keys.
export const normalizeKiroConfiguration = normalizeRegionConfiguration;

export const KEYS_MODE = defineAuthMode({
  id: 'keys',
  label: 'Keys',
  backend: 'bedrock',
  mechanisms: ['api-key'],
  defaultConnectionId: 'legacy-platform-bedrock',
  normalizeConfiguration: normalizeRegionConfiguration,
});

// Planned stubs keep persisted mode ids parseable until a provider registers the mode;
// their checks are the pre-registry ones, so stored rows normalize unchanged.
export const PLANNED_IAM_MODE = defineAuthMode({
  id: 'iam',
  label: 'IAM',
  backend: 'bedrock',
  mechanisms: ['assume-role'],
  planned: true,
  modelDiscovery: 'runtime',
  normalizeConfiguration: (configuration) => {
    // externalId is tolerated so rows written by the IAM provider still parse after a rollback.
    const out = normalizeConfigurationFields(configuration, {
      region: 'string',
      roleArn: 'string',
      externalId: 'string',
    });
    if (
      !out.region ||
      !/^arn:aws(?:-us-gov|-cn)?:iam::\d{12}:role\/[\w+=,.@/-]+$/.test(out.roleArn || '')
    ) {
      throw authError('AGENT_AUTH_INVALID', 'IAM role ARN and region are required');
    }
    return out;
  },
});

export const PLANNED_LITELLM_MODE = defineAuthMode({
  id: 'litellm',
  label: 'LiteLLM',
  backend: 'litellm',
  mechanisms: ['api-key', 'oauth-machine', 'oauth-user'],
  planned: true,
  modelDiscovery: 'runtime',
  normalizeConfiguration: (configuration, { mechanism }) => {
    const out = normalizeConfigurationFields(configuration, {
      endpoint: 'endpoint',
      audience: 'string',
      issuer: 'endpoint',
      clientId: 'string',
      scopes: 'scopes',
    });
    if (!out.endpoint) throw authError('AGENT_AUTH_INVALID', 'Gateway endpoint is required');
    if (mechanism.startsWith('oauth-') && (!out.issuer || !out.clientId || !out.audience)) {
      throw authError('AGENT_AUTH_INVALID', 'OAuth issuer, clientId and audience are required');
    }
    return out;
  },
});
