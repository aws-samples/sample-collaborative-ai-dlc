import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
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
import { redeemAgentBinding } from '../shared/agent-auth-redemption.js';
import { createAgentConnectionRepository } from '../shared/agent-connection-repository.js';
import {
  credentialChangeAffects,
  bindingIdentity,
  authError,
} from '../shared/agent-auth-catalog.js';
import {
  loadAgentCredentialGrantSecret,
  verifyAgentCredentialGrant,
  verifyBedrockCredentialRenewal,
  signBedrockCredentialRenewal,
  BEDROCK_RENEWAL_TTL_SECONDS,
} from '../shared/agent-credential-grants.js';
import { STSClient } from '@aws-sdk/client-sts';
import { assumeInferenceRole } from './bedrock-iam.js';
import { KEY_REDEMPTION_ADAPTERS } from '../shared/agent-auth-redemption.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'credential-broker' } });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const sts = new STSClient({});

const CREDENTIAL_ACTIVE_EXECUTION_STATUSES = new Set(['CREATED', 'RUNNING']);
const RESOLVE_AGENT_CREDENTIALS = 'resolve-agent-credentials';
const RENEW_BEDROCK_CREDENTIALS = 'renew-bedrock-credentials';

const loggableAgentCredentialErrorCode = (error) => {
  if (['AccessDenied', 'AccessDeniedException'].includes(error?.name))
    return 'BEDROCK_IAM_ACCESS_DENIED';
  switch (error?.code) {
    case 'AGENT_AUTH_CONNECTION_UNAVAILABLE':
      return 'AGENT_AUTH_CONNECTION_UNAVAILABLE';
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
  {
    ssmClient = ssm,
    ddbClient = ddb,
    stsClient = sts,
    secret = null,
    env = process.env,
    now = undefined,
  } = {},
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
  const verification = claims.purpose === 'verify-bedrock-iam';
  if (
    verification &&
    (renewal ||
      claims.executionId ||
      claims.bindings.length !== 1 ||
      claims.bindings[0].mechanism !== 'assume-role')
  )
    throw authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Invalid IAM verification grant');
  const repository = createAgentConnectionRepository({
    ddb: ddbClient,
    tableName: env.V2_PROCESS_TABLE,
    base: env.AGENT_SETTINGS_SSM_PREFIX || '',
  });
  const policy = await repository.getPolicy();
  if (policy.pendingReview) {
    const pending = await repository.getReview(policy.pendingReview);
    if (
      claims.bindings.some((binding) =>
        credentialChangeAffects(pending?.candidate, binding, claims.projectId),
      )
    ) {
      throw authError('AGENT_AUTH_CHANGE_IN_PROGRESS', 'The selected credential is being updated');
    }
  }
  if (claims.version === 2 && claims.executionId) {
    const { Item: execution } = await ddbClient.send(
      new GetCommand({
        TableName: env.V2_PROCESS_TABLE,
        Key: executionMetaKey(claims.executionId),
        ConsistentRead: true,
      }),
    );
    if (
      !execution ||
      execution.projectId !== claims.projectId ||
      (claims.purpose === 'execution' &&
        (claims.bindings.length !== 1 ||
          bindingIdentity(execution.credentialBinding) !== bindingIdentity(claims.bindings[0])))
    ) {
      throw authError(
        'AGENT_CREDENTIAL_GRANT_INVALID',
        'Grant does not match the execution binding',
      );
    }
  }
  const iamAdapter = async ({ connection }) => ({
    iamCredentials: await assumeInferenceRole(claims, connection, stsClient),
    renewalToken: verification
      ? null
      : renewal
        ? renewalToken
        : signBedrockCredentialRenewal(claims, key),
    renewalExpiresAt:
      (verification || renewal ? claims.expiresAt : claims.issuedAt + BEDROCK_RENEWAL_TTL_SECONDS) *
      1000,
  });
  const credentials = await Promise.all(
    claims.bindings.map(async (binding) => {
      try {
        // Verification is a separately signed, short-lived control-plane purpose.
        // It cannot select an execution connection or mint renewal authority.
        if (verification) return { binding, ...(await iamAdapter({ connection: binding })) };
        return await redeemAgentBinding({
          binding,
          projectId: claims.projectId,
          repository,
          ssm: ssmClient,
          base: env.AGENT_SETTINGS_SSM_PREFIX || '',
          adapters: { ...KEY_REDEMPTION_ADAPTERS, 'bedrock:assume-role': iamAdapter },
        });
      } catch (error) {
        if (renewal || claims.purpose !== 'capabilities' || binding.mechanism !== 'assume-role')
          throw error;
        // Broken Bedrock authentication does not suppress independent Kiro availability.
        return { binding, error: loggableAgentCredentialErrorCode(error) };
      }
    }),
  );
  return {
    purpose: claims.purpose,
    projectId: claims.projectId,
    executionId: claims.executionId,
    credentials,
  };
};

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
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
    logger.error('request denied', {
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
  RENEW_BEDROCK_CREDENTIALS,
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  authorizeAgentCredentialRequest,
  executionIncludesRepository,
  loggableAgentCredentialErrorCode,
  authorizeCredentialRequest,
};
