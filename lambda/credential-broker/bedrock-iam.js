import { AssumeRoleCommand } from '@aws-sdk/client-sts';
import { authError } from '../shared/agent-auth-protocol.js';

// STS bounds a role session to [900, 3600] seconds for a chained or default role.
const MAX_SESSION_SECONDS = 3600;
const MIN_SESSION_SECONDS = 900;

// Even a mistakenly overprivileged inference role cannot give an agent STS,
// IAM, or application-data access through this credential path.
export const INFERENCE_SESSION_POLICY = JSON.stringify({
  Version: '2012-10-17',
  Statement: [
    { Effect: 'Deny', Action: 'sts:AssumeRole', Resource: '*' },
    {
      Effect: 'Allow',
      Action: [
        'bedrock:InvokeModel',
        'bedrock:InvokeModelWithResponseStream',
        'bedrock:GetInferenceProfile',
        'bedrock:ListInferenceProfiles',
        'bedrock:ListFoundationModels',
        'bedrock-mantle:CreateInference',
        'bedrock-mantle:GetInference',
        'bedrock-mantle:CancelInference',
        'bedrock-mantle:DeleteInference',
        'bedrock-mantle:GetProject',
        'bedrock-mantle:ListModels',
        'bedrock-mantle:ListTagsForResource',
        'bedrock-mantle:ListProjects',
      ],
      Resource: '*',
    },
  ],
});

// `deadline` (epoch seconds) is the signed renewal ceiling: no session may outlive it, and a
// remaining window shorter than the STS minimum means the renewal authority has expired.
export const assumeInferenceRole = async (
  claims,
  binding,
  stsClient,
  { deadline = null, now = Date.now } = {},
) => {
  const durationSeconds =
    deadline === null
      ? MAX_SESSION_SECONDS
      : Math.min(MAX_SESSION_SECONDS, Math.floor(deadline - now() / 1000));
  if (durationSeconds < MIN_SESSION_SECONDS)
    throw authError('AGENT_CREDENTIAL_GRANT_EXPIRED', 'Credential renewal authority has expired');
  const result = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: binding.configuration.roleArn,
      RoleSessionName: `collaborative-${claims.grantId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`,
      DurationSeconds: durationSeconds,
      ...(binding.configuration.externalId ? { ExternalId: binding.configuration.externalId } : {}),
      Policy: INFERENCE_SESSION_POLICY,
    }),
  );
  const credentials = result.Credentials;
  if (
    !credentials?.AccessKeyId ||
    !credentials.SecretAccessKey ||
    !credentials.SessionToken ||
    !credentials.Expiration
  ) {
    throw new Error('STS returned incomplete inference credentials');
  }
  return {
    AccessKeyId: credentials.AccessKeyId,
    SecretAccessKey: credentials.SecretAccessKey,
    Token: credentials.SessionToken,
    Expiration: new Date(credentials.Expiration).toISOString(),
  };
};
