import { authError } from './agent-auth-protocol.js';
import { defineAuthMode, normalizeConfigurationFields } from './agent-auth-mode-registry.js';

const invalid = (message) => authError('AGENT_AUTH_INVALID', message);

export const BEDROCK_IAM_ROLE_PATTERN =
  /^arn:(aws|aws-us-gov|aws-cn):iam::(\d{12}):role\/((?:[\w+=,.@-]+\/)*[\w+=,.@-]{1,64})$/;

export const normalizeBedrockIam = (input) => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw invalid('A Bedrock IAM role and region are required');
  }
  const roleArn = String(input.roleArn ?? '').trim();
  const region = String(input.region ?? '').trim();
  if (!BEDROCK_IAM_ROLE_PATTERN.test(roleArn) || roleArn.length > 2048) {
    throw invalid('Enter a valid IAM role ARN');
  }
  if (!/^[a-z]{2}(?:-[a-z]+)+-\d+$/.test(region)) {
    throw invalid('Enter a valid AWS region');
  }
  const partition = roleArn.split(':')[1];
  const regionPartition = region.startsWith('cn-')
    ? 'aws-cn'
    : region.startsWith('us-gov-')
      ? 'aws-us-gov'
      : 'aws';
  if (partition !== regionPartition)
    throw invalid('The role and region must use the same AWS partition');
  const externalId = String(input.externalId ?? '').trim();
  if (externalId && !/^[\w+=,.@:/-]{2,1224}$/.test(externalId)) {
    throw invalid('The external ID contains unsupported characters or has an invalid length');
  }
  return { roleArn, region, ...(externalId ? { externalId } : {}) };
};

export const BEDROCK_IAM_MODE = defineAuthMode({
  id: 'iam',
  label: 'IAM',
  backend: 'bedrock',
  mechanisms: ['assume-role'],
  modelDiscovery: 'runtime',
  normalizeConfiguration: (configuration) =>
    normalizeBedrockIam(
      normalizeConfigurationFields(configuration, {
        region: 'string',
        roleArn: 'string',
        externalId: 'string',
      }),
    ),
});
