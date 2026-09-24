import { createHash } from 'node:crypto';

import {
  authError,
  normalizeBedrockIam,
  BEDROCK_IAM_ROLE_PATTERN as rolePattern,
} from './agent-auth-catalog.js';
export { normalizeBedrockIam } from './agent-auth-catalog.js';

const invalid = (message) => authError('AGENT_AUTH_INVALID', message);
const document = (Statement) => ({ Version: '2012-10-17', Statement });
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const json = (value) => JSON.stringify(value, null, 2);

// Both accounts receive explicit policies. Setup grants the broker permission
// to assume this exact role; the application never modifies IAM itself.
export const generateBedrockIamSetup = ({ brokerRoleArn, config }) => {
  const iam = normalizeBedrockIam(config);
  const source = rolePattern.exec(brokerRoleArn ?? '');
  const target = rolePattern.exec(iam.roleArn);
  if (!source || source[1] !== target[1]) {
    throw invalid('The broker role and inference role must be in the same AWS partition');
  }
  if (brokerRoleArn === iam.roleArn) throw invalid('Use a dedicated Bedrock inference role');
  const [, partition, accountId, rolePath] = target;
  const roleName = rolePath.split('/').at(-1);
  const sourceRoleName = source[3].split('/').at(-1);
  const iamPath = rolePath.includes('/')
    ? `/${rolePath.slice(0, rolePath.lastIndexOf('/') + 1)}`
    : '/';
  const policyName = `CollaborativeBedrock-${createHash('sha256').update(iam.roleArn).digest('hex').slice(0, 12)}`;
  const trustPolicy = document([
    {
      Effect: 'Allow',
      Principal: { AWS: brokerRoleArn },
      Action: 'sts:AssumeRole',
      ...(iam.externalId
        ? { Condition: { StringEquals: { 'sts:ExternalId': iam.externalId } } }
        : {}),
    },
  ]);
  const assumeRolePolicy = document([
    {
      Effect: 'Allow',
      Action: 'sts:AssumeRole',
      Resource: iam.roleArn,
    },
  ]);
  const inferencePolicy = document([
    {
      Sid: 'BedrockInference',
      Effect: 'Allow',
      Action: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:GetInferenceProfile',
      ],
      Resource: [
        `arn:${partition}:bedrock:*::foundation-model/*`,
        `arn:${partition}:bedrock:*:${accountId}:inference-profile/*`,
        `arn:${partition}:bedrock:*:${accountId}:application-inference-profile/*`,
      ],
    },
    {
      Sid: 'ModelDiscovery',
      Effect: 'Allow',
      Action: ['bedrock:ListInferenceProfiles', 'bedrock:ListFoundationModels'],
      Resource: '*',
    },
    {
      Sid: 'CodexInference',
      Effect: 'Allow',
      Action: [
        'bedrock-mantle:CreateInference',
        'bedrock-mantle:GetInference',
        'bedrock-mantle:CancelInference',
        'bedrock-mantle:DeleteInference',
        'bedrock-mantle:GetProject',
        'bedrock-mantle:ListModels',
        'bedrock-mantle:ListTagsForResource',
      ],
      Resource: `arn:${partition}:bedrock-mantle:${iam.region}:${accountId}:project/*`,
    },
    {
      Sid: 'CodexProjectDiscovery',
      Effect: 'Allow',
      Action: 'bedrock-mantle:ListProjects',
      Resource: '*',
    },
  ]);
  const accountCheck = (account) =>
    `[ "$(aws sts get-caller-identity --query Account --output text)" = ${shellQuote(account)} ] || { echo 'Wrong AWS account. Switch accounts before continuing.' >&2; exit 1; }`;
  return {
    config: iam,
    brokerRoleArn,
    applicationAccountId: source[2],
    inferenceAccountId: accountId,
    trustPolicy,
    assumeRolePolicy,
    inferencePolicy,
    inferenceCommands: [
      '# Run in AWS CloudShell in the inference account. Creates a NEW dedicated role.',
      'set -eu',
      accountCheck(accountId),
      `aws iam create-role --role-name ${shellQuote(roleName)} --path ${shellQuote(iamPath)} --assume-role-policy-document ${shellQuote(json(trustPolicy))} --max-session-duration 3600`,
      `aws iam put-role-policy --role-name ${shellQuote(roleName)} --policy-name CollaborativeBedrockInference --policy-document ${shellQuote(json(inferencePolicy))}`,
    ].join('\n\n'),
    applicationCommands: [
      '# Run in AWS CloudShell in the application account.',
      'set -eu',
      accountCheck(source[2]),
      `aws iam put-role-policy --role-name ${shellQuote(sourceRoleName)} --policy-name ${shellQuote(policyName)} --policy-document ${shellQuote(json(assumeRolePolicy))}`,
    ].join('\n\n'),
  };
};
