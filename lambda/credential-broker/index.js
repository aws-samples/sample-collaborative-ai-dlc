import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand } from '@aws-sdk/lib-dynamodb';
import { SSMClient } from '@aws-sdk/client-ssm';
import { STSClient } from '@aws-sdk/client-sts';
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
import {
  AGENT_CREDENTIAL_STORE_ERROR_CODES,
  CREDENTIAL_VALUE_KINDS,
  looksLikeRoleBindingValue,
  parseRoleBindingValue,
  readCredentialBindingValue,
} from '../shared/agent-credentials.js';
import {
  BEDROCK_ROLE_ERROR_CODES,
  ROLE_SESSION_DURATION_SECONDS,
  assumeBedrockRole,
} from '../shared/bedrock-role.js';
import { verifyIssuedAgentCredentialGrant } from '../shared/agent-credential-grants.js';
import { AGENT_AUTH_MODES } from '../shared/agent-command-registry.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const ssm = new SSMClient({});
const sts = new STSClient({});
const secrets = new SecretsManagerClient({});

const CREDENTIAL_ACTIVE_EXECUTION_STATUSES = new Set(['CREATED', 'RUNNING']);
const RESOLVE_AGENT_CREDENTIALS = 'resolve-agent-credentials';

// ── Bedrock IAM-role resolution ──
// specs/bedrock-iam-role-credential-mode: req-broker-side-assume,
// req-broker-credential-resolution, req-session-name-attribution.
//
// The broker is already the sole IAM principal permitted to read credential
// material and already validates a signed grant, so it is already the trusted
// resolver — which is why the AssumeRole happens HERE and never in a container.
// The container never names a role: the ARN is read from SSM at resolution time,
// keyed off the binding the verified grant authorizes.
//
// The call itself, the session-name composition and the error classification live
// in shared/bedrock-role.js, because the metadata broker's bind-time preflight
// (req-binding-preflight) must exercise the SAME code it is predicting.

const loggableAgentCredentialErrorCode = (error) => {
  switch (error?.code) {
    case 'AGENT_CREDENTIAL_GRANT_EXPIRED':
      return 'AGENT_CREDENTIAL_GRANT_EXPIRED';
    case 'AGENT_CREDENTIAL_GRANT_INVALID':
      return 'AGENT_CREDENTIAL_GRANT_INVALID';
    case 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED':
      return 'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED';
    // req-resolution-resilience: SSM is on the critical path of every resolution,
    // so a throttled or unavailable store is reported as itself rather than as a
    // generic broker failure. Both still reach the stage as
    // credential_resolution_failed; the code is what tells an operator whether to
    // wait for the retry or fix a permission.
    case AGENT_CREDENTIAL_STORE_ERROR_CODES.THROTTLED:
    case AGENT_CREDENTIAL_STORE_ERROR_CODES.UNAVAILABLE:
      return error.code;
    case BEDROCK_ROLE_ERROR_CODES.BINDING_INVALID:
    case BEDROCK_ROLE_ERROR_CODES.ASSUME_DENIED:
    case BEDROCK_ROLE_ERROR_CODES.ASSUME_THROTTLED:
    case BEDROCK_ROLE_ERROR_CODES.RESOLUTION_FAILED:
      return error.code;
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

// Resolve ONE authorized binding into a kind-discriminated credential entry.
//
// dec-explicit-discriminator: the resolver treats an entry carrying no `value` as
// a MISSING provider (con-missing-value-is-missing), so a role result cannot
// reuse the bearer shape. `kind` is always present and is the only thing the
// caller may branch on — never field presence.
const resolveAgentCredentialEntry = async (
  binding,
  { ssmClient, stsClient, env, projectId, purpose },
) => {
  const value = await readCredentialBindingValue(ssmClient, {
    base: env.AGENT_SETTINGS_SSM_PREFIX || '',
    binding,
    projectId,
  });
  if (!value) return { binding, kind: null, value: null };
  if (!looksLikeRoleBindingValue(value)) {
    return { binding, kind: CREDENTIAL_VALUE_KINDS.BEARER, value };
  }
  // Throws BEDROCK_ROLE_BINDING_INVALID. Validation also lives on the settings
  // write path (req-single-parameter-encoding); this is the fail-closed backstop
  // for a value written before that existed.
  const { roleArn, externalId } = parseRoleBindingValue(value);
  // req-capabilities-authed: a capabilities request answers "is this binding
  // usable", which the binding itself already answers. Minting here would mean
  // one AssumeRole per settings render, which AWS warns can exceed the STS
  // request-rate quota — so this path deliberately performs NO AssumeRole.
  if (purpose === AGENT_AUTH_MODES.CAPABILITIES) {
    return { binding, kind: CREDENTIAL_VALUE_KINDS.ROLE, usable: true };
  }
  return {
    binding,
    kind: CREDENTIAL_VALUE_KINDS.ROLE,
    credentials: await assumeBedrockRole(
      // req-least-privilege-assume: the ceiling comes from the environment, rendered
      // from the same Terraform definition as the customer-facing grant, so what is
      // enforced cannot drift from what is documented.
      { roleArn, externalId, projectId, sessionPolicy: env.BEDROCK_SESSION_POLICY || null },
      stsClient,
    ),
  };
};

const authorizeAgentCredentialRequest = async (
  { grant },
  { ssmClient = ssm, stsClient = sts, secret = null, env = process.env, now = undefined } = {},
) => {
  if (!grant) {
    throw Object.assign(new Error('Agent credential grant is required'), {
      code: 'AGENT_CREDENTIAL_GRANT_INVALID',
    });
  }
  const claims = await verifyIssuedAgentCredentialGrant(ssmClient, grant, {
    env,
    secret,
    ...(now ? { now } : {}),
  });
  const credentials = await Promise.all(
    claims.bindings.map((binding) =>
      resolveAgentCredentialEntry(binding, {
        ssmClient,
        stsClient,
        env,
        projectId: claims.projectId,
        purpose: claims.purpose,
      }),
    ),
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
    if (action === RESOLVE_AGENT_CREDENTIALS) {
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
    const code =
      action === RESOLVE_AGENT_CREDENTIALS
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
  ROLE_SESSION_DURATION_SECONDS,
  authorizeAgentCredentialRequest,
  executionIncludesRepository,
  loggableAgentCredentialErrorCode,
  authorizeCredentialRequest,
};
