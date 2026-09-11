import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { STSClient, AssumeRoleCommand } from '@aws-sdk/client-sts';
import { executionMetaKey } from '../shared/v2-process-keys.js';
import {
  ACTIVE,
  canonicalRepo,
  getBinding,
  invalidationReasonForError,
  loggableErrorCode,
  markBindingInvalid,
} from '../shared/source-control-bindings.js';
import { resolveBindingCredential } from '../shared/source-control-credentials.js';
import { repoUrl, repoProvider } from '../shared/repo-provider.js';
import { readCredentialBindingValue } from '../shared/agent-credentials.js';
import {
  loadAgentCredentialGrantSecret,
  BEDROCK_RENEWAL_TTL_SECONDS,
  signBedrockCredentialRenewal,
  verifyAgentCredentialGrant,
  verifyBedrockCredentialRenewal,
} from '../shared/agent-credential-grants.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const sts = new STSClient({});

const CREDENTIAL_ACTIVE_EXECUTION_STATUSES = new Set(['CREATED', 'RUNNING']);
const RESOLVE_AGENT_CREDENTIALS = 'resolve-agent-credentials';
const RENEW_BEDROCK_CREDENTIALS = 'renew-bedrock-credentials';

// Even a mistakenly overprivileged inference role cannot give an agent STS,
// IAM, or application-data access through this credential path.
const INFERENCE_SESSION_POLICY = JSON.stringify({
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

const assumeInferenceRole = async (claims, binding, stsClient) => {
  const result = await stsClient.send(
    new AssumeRoleCommand({
      RoleArn: binding.iam.roleArn,
      RoleSessionName: `collaborative-${claims.grantId.replace(/[^a-zA-Z0-9-]/g, '').slice(0, 40)}`,
      DurationSeconds: 3600,
      ...(binding.iam.externalId ? { ExternalId: binding.iam.externalId } : {}),
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

const loggableAgentCredentialErrorCode = (error) => {
  if (['AccessDenied', 'AccessDeniedException'].includes(error?.name))
    return 'BEDROCK_IAM_ACCESS_DENIED';
  switch (error?.code) {
    case 'AGENT_CREDENTIAL_GRANT_EXPIRED':
      return 'AGENT_CREDENTIAL_GRANT_EXPIRED';
    case 'AGENT_CREDENTIAL_GRANT_INVALID':
      return 'AGENT_CREDENTIAL_GRANT_INVALID';
    case 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED':
      return 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED';
    default:
      return 'AGENT_CREDENTIAL_BROKER_FAILED';
  }
};

const executionIncludesRepository = (meta, provider, repository) => {
  if (!meta || !provider || !repository) return false;
  let requested;
  try {
    requested = canonicalRepo(provider, repository);
  } catch {
    return false;
  }
  return (meta.repos ?? []).some((repo) => {
    const expectedProvider = repoProvider(repo, meta?.gitProvider, meta?.repoProviders);
    if (expectedProvider !== provider) return false;
    try {
      return canonicalRepo(provider, repoUrl(repo)) === requested;
    } catch {
      return false;
    }
  });
};

const authorizeCredentialRequest = async (
  { executionId, projectId, provider, repository, requiredAccess = 'write' },
  { ddbClient = ddb, ssmClient = ssm, secretsClient = secrets } = {},
) => {
  if (!executionId || !projectId || !provider || !repository) {
    throw Object.assign(
      new Error('executionId, projectId, provider, and repository are required'),
      {
        code: 'INVALID_REQUEST',
      },
    );
  }
  if (!['identity', 'read', 'write'].includes(requiredAccess)) {
    throw Object.assign(new Error('requiredAccess must be identity, read, or write'), {
      code: 'INVALID_REQUEST',
    });
  }
  const { Item: execution } = await ddbClient.send(
    new GetCommand({
      TableName: process.env.V2_PROCESS_TABLE,
      Key: executionMetaKey(executionId),
      ConsistentRead: true,
    }),
  );
  if (!execution || execution.projectId !== projectId) {
    throw Object.assign(new Error('Execution was not found for this project'), {
      code: 'EXECUTION_NOT_FOUND',
    });
  }
  if (!CREDENTIAL_ACTIVE_EXECUTION_STATUSES.has(execution.status)) {
    throw Object.assign(new Error('Execution is not active'), {
      code: 'EXECUTION_NOT_ACTIVE',
    });
  }
  if (!executionIncludesRepository(execution, provider, repository)) {
    throw Object.assign(new Error('Repository is not part of this execution'), {
      code: 'REPOSITORY_NOT_ON_EXECUTION',
    });
  }
  const binding = await getBinding(ddbClient, projectId, provider, repository);
  if (!binding || binding.status !== ACTIVE) {
    throw Object.assign(new Error('Project source-control binding is not active'), {
      code: 'SOURCE_CONTROL_NOT_READY',
    });
  }
  if (requiredAccess === 'write' && !binding.capabilities?.repositoryWrite) {
    throw Object.assign(new Error('Project source-control binding is not writable'), {
      code: 'WRITE_ACCESS_REQUIRED',
    });
  }
  if (requiredAccess === 'identity') {
    return {
      committer:
        binding.actorName && binding.actorEmail
          ? { name: binding.actorName, email: binding.actorEmail }
          : null,
    };
  }
  try {
    return await resolveBindingCredential({
      ddb: ddbClient,
      ssm: ssmClient,
      secrets: secretsClient,
      binding,
      requiredAccess,
    });
  } catch (error) {
    const invalidReason = invalidationReasonForError(error);
    if (invalidReason) {
      await markBindingInvalid(ddbClient, binding, invalidReason).catch(() => {});
    }
    throw error;
  }
};

const authorizeAgentCredentialRequest = async (
  { grant, action = RESOLVE_AGENT_CREDENTIALS, renewalToken },
  { ssmClient = ssm, stsClient = sts, secret = null, env = process.env, now = undefined } = {},
) => {
  const renewal = action === RENEW_BEDROCK_CREDENTIALS;
  if (!(renewal ? renewalToken : grant)) {
    throw Object.assign(new Error('Agent credential grant is required'), {
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
  }
  const key = secret ?? (await loadAgentCredentialGrantSecret(ssmClient, { env }));
  const claims = (renewal ? verifyBedrockCredentialRenewal : verifyAgentCredentialGrant)(
    renewal ? renewalToken : grant,
    key,
    now ? { now } : {},
  );
  const credentials = await Promise.all(
    claims.bindings.map(async (binding) => {
      if (binding.authType === 'iam') {
        try {
          return {
            binding,
            iamCredentials: await assumeInferenceRole(claims, binding, stsClient),
            renewalToken: renewal ? renewalToken : signBedrockCredentialRenewal(claims, key),
            renewalExpiresAt:
              (renewal ? claims.expiresAt : claims.issuedAt + BEDROCK_RENEWAL_TTL_SECONDS) * 1000,
          };
        } catch (error) {
          // A broken Bedrock connection must not hide a usable Kiro key from
          // capability discovery. Execution and renewal still fail closed.
          if (renewal || claims.purpose !== 'capabilities') throw error;
          return { binding, error: loggableAgentCredentialErrorCode(error) };
        }
      }
      return {
        binding,
        value:
          (await readCredentialBindingValue(ssmClient, {
            base: env.AGENT_SETTINGS_SSM_PREFIX || '',
            binding,
            projectId: claims.projectId,
          })) || null,
      };
    }),
  );
  return {
    purpose: claims.purpose,
    projectId: claims.projectId,
    executionId: claims.executionId,
    credentials,
  };
};

export const handler = async (event) => {
  const action = event?.action || 'source-control';
  try {
    if ([RESOLVE_AGENT_CREDENTIALS, RENEW_BEDROCK_CREDENTIALS].includes(action)) {
      return {
        ok: true,
        ...(await authorizeAgentCredentialRequest(event || {})),
      };
    }
    const credential = await authorizeCredentialRequest(event || {});
    if (event?.requiredAccess === 'identity') {
      return { ok: true, committer: credential.committer };
    }
    return {
      ok: true,
      username: credential.username,
      password: credential.token,
      committer: credential.committer,
    };
  } catch (error) {
    // Both code helpers return only allowlisted constants — never provider-
    // derived error text, which can carry credential material.
    const code = [RESOLVE_AGENT_CREDENTIALS, RENEW_BEDROCK_CREDENTIALS].includes(action)
      ? loggableAgentCredentialErrorCode(error)
      : loggableErrorCode(error, 'CREDENTIAL_BROKER_FAILED');
    console.error('[credential-broker] request denied', {
      code,
      action,
      executionId: event?.executionId || null,
      projectId: event?.projectId || null,
      provider: event?.provider || null,
      repository: event?.repository || null,
    });
    return { ok: false, code };
  }
};

export {
  RESOLVE_AGENT_CREDENTIALS,
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  authorizeAgentCredentialRequest,
  executionIncludesRepository,
  loggableAgentCredentialErrorCode,
  authorizeCredentialRequest,
};
