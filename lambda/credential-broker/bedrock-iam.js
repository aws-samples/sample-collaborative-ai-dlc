import { AssumeRoleCommand } from '@aws-sdk/client-sts';

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

export const assumeInferenceRole = async (claims, binding, stsClient) => {
  const result = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: binding.configuration.roleArn,
      RoleSessionName: `collaborative-${claims.grantId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`,
      DurationSeconds: 3600,
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
