import { authorizeAgentCredentialRequest } from './agent-authentication.js';
import {
  isAgentCredentialAction,
  loggableAgentCredentialErrorCode,
} from './agent-provider-registry.js';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { SecretsManagerClient } from '@aws-sdk/client-secrets-manager';
import { STSClient } from '@aws-sdk/client-sts';
import { executionMetaKey } from '../shared/v2-process-keys.js';
import {
  ACTIVE,
  canonicalRepo,
  getBinding,
  invalidateBindingsForError,
  loggableErrorCode,
} from '../shared/source-control-bindings.js';
import { resolveBindingCredential } from '../shared/source-control-credentials.js';
import { repoUrl, repoProvider } from '../shared/repo-provider.js';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'credential-broker' } });

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const secrets = new SecretsManagerClient({});
const sts = new STSClient({});

const CREDENTIAL_ACTIVE_EXECUTION_STATUSES = new Set(['CREATED', 'RUNNING']);
const RESOLVE_AGENT_CREDENTIALS = 'resolve-agent-credentials';

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
  { ddbClient = ddb, ssmClient = ssm, secretsClient = secrets, stsClient = sts } = {},
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
      sts: stsClient,
      binding,
      requiredAccess,
      executionId,
    });
  } catch (error) {
    await invalidateBindingsForError(ddbClient, binding, error).catch(() => {});
    throw error;
  }
};

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
  const action = event?.action || 'source-control';
  try {
    if (isAgentCredentialAction(action)) {
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
      // Providers whose git password is not the API token (CodeCommit: a
      // SigV4 signature) return it explicitly; the rest reuse the token.
      password: credential.password ?? credential.token,
      committer: credential.committer,
    };
  } catch (error) {
    // Both code helpers return only allowlisted constants — never provider-
    // derived error text, which can carry credential material.
    const code = isAgentCredentialAction(action)
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
  CREDENTIAL_ACTIVE_EXECUTION_STATUSES,
  authorizeAgentCredentialRequest,
  executionIncludesRepository,
  loggableAgentCredentialErrorCode,
  authorizeCredentialRequest,
};
