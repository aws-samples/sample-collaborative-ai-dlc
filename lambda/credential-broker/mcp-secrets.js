import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { executionMetaKey, stageKey } from '../shared/v2-process-keys.js';
import { stageInstanceId } from '../shared/v2-execution-plan.js';
import { mcpSecretsBase } from '../shared/mcp-secrets-store.js';
import { loadAgentCredentialGrantSecret } from '../shared/agent-credential-grants.js';
import { verifyMcpSecretVerificationGrant } from '../shared/mcp-secret-verification-grant.js';
import {
  isMcpProjectId,
  isMcpRecord,
  mcpSecretConfigAuthority,
  mcpSecretError,
} from '../shared/mcp-secret-config.js';
import {
  assertGatewayExecution,
  engineDataEnabled,
  gatewayScopeDenied,
  verifyBrokerGatewayGrant,
} from './gateway-authority.js';

export const MCP_SECRET_ERROR_CODES = new Set([
  'MCP_SECRET_REQUEST_INVALID',
  'MCP_SECRET_AUTHORITY_REQUIRED',
  'MCP_SECRETS_DISABLED',
  'MCP_SECRET_CONFIG_INVALID',
  'MCP_SECRET_SCOPE_MISMATCH',
  'MCP_SECRET_NOT_CONFIGURED',
  'MCP_VERIFICATION_GRANT_INVALID',
  'MCP_VERIFICATION_GRANT_EXPIRED',
  'MCP_SECRET_RESERVED',
  'MCP_SECRET_COLLISION',
  'MCP_SECRET_MISSING',
  'MCP_SECRET_READ_FAILED',
]);
const REQUEST_KEYS = [
  'action',
  'gatewayGrant',
  'verificationGrant',
  'projectId',
  'mcpServersByTier',
  'unsavedSecrets',
];
const failure = (code) => ({
  ok: false,
  code,
  error: {
    MCP_SECRET_RESERVED: 'A secret reference uses a reserved runtime variable. Rename it.',
    MCP_SECRET_COLLISION:
      'A secret reference is used in both tiers. Rename it or override the server by name.',
    MCP_SECRET_MISSING: 'A referenced secret is not set in its tier. Enter or save it, then retry.',
    MCP_SECRET_READ_FAILED: 'MCP secrets could not be read. Retry the verification.',
  }[code],
});

const stageAuthority = async (request, { ddbClient, env, verifyGrant }) => {
  if (Object.hasOwn(request, 'unsavedSecrets')) throw mcpSecretError('MCP_SECRET_REQUEST_INVALID');
  const grant = await verifyGrant(request.gatewayGrant);
  if (
    grant.mode !== 'stage' ||
    !grant.stageId ||
    !isMcpProjectId(grant.projectId) ||
    (Object.hasOwn(request, 'projectId') && request.projectId !== grant.projectId)
  )
    throw gatewayScopeDenied();
  const { Item: meta } = await ddbClient.send(
    new GetCommand({
      TableName: env.V2_PROCESS_TABLE,
      Key: executionMetaKey(grant.executionId),
      ConsistentRead: true,
    }),
  );
  assertGatewayExecution(grant, meta);
  if (meta.executionId !== undefined && meta.executionId !== grant.executionId)
    throw gatewayScopeDenied();
  if (
    typeof meta.workflowId !== 'string' ||
    !meta.workflowId ||
    !Number.isSafeInteger(meta.workflowVersion) ||
    meta.workflowVersion < 1
  )
    throw gatewayScopeDenied();
  // run-stage builds its plan without settings.executionId, hence the workflow-pin namespace.
  const instanceId = stageInstanceId(
    `${meta.workflowId}@${meta.workflowVersion}`,
    grant.stageId,
    grant.unitSlug,
    grant.sectionIndex,
  );
  const { Item: stage } = await ddbClient.send(
    new GetCommand({
      TableName: env.V2_PROCESS_TABLE,
      Key: stageKey(grant.executionId, instanceId),
      ConsistentRead: true,
    }),
  );
  if (
    !stage ||
    stage.executionId !== grant.executionId ||
    stage.stageId !== grant.stageId ||
    stage.stageInstanceId !== instanceId
  )
    throw gatewayScopeDenied();
  const authority = mcpSecretConfigAuthority(
    meta.mcpServersByTier ??
      (meta.customMcpServers ? { global: {}, project: meta.customMcpServers } : null),
  );
  if (
    Object.hasOwn(request, 'mcpServersByTier') &&
    mcpSecretConfigAuthority(request.mcpServersByTier).configDigest !== authority.configDigest
  )
    throw mcpSecretError('MCP_SECRET_SCOPE_MISMATCH');
  return { ...authority, projectId: grant.projectId, overrides: {}, verification: false };
};

const verificationAuthority = async (request, { ssmClient, env, now }) => {
  const claims = verifyMcpSecretVerificationGrant(
    request.verificationGrant,
    await loadAgentCredentialGrantSecret(ssmClient, { env, now }),
    { now },
  );
  if (
    !Object.hasOwn(request, 'mcpServersByTier') ||
    (Object.hasOwn(request, 'projectId') && request.projectId !== claims.projectId)
  )
    throw mcpSecretError('MCP_SECRET_SCOPE_MISMATCH');
  const authority = mcpSecretConfigAuthority(request.mcpServersByTier);
  if (
    authority.configDigest !== claims.configDigest ||
    ['global', 'project'].some(
      (tier) =>
        JSON.stringify(authority.allowedRefs[tier]) !== JSON.stringify(claims.allowedRefs[tier]),
    ) ||
    (claims.projectId === null && Object.keys(authority.config.project).length)
  )
    throw mcpSecretError('MCP_SECRET_SCOPE_MISMATCH');
  const unsaved = request.unsavedSecrets ?? {};
  if (
    !isMcpRecord(unsaved) ||
    Object.keys(unsaved).some(
      (ref) =>
        !claims.allowedRefs[claims.overrideTier].includes(ref) ||
        typeof unsaved[ref] !== 'string' ||
        Buffer.byteLength(unsaved[ref]) > 8192,
    ) ||
    Buffer.byteLength(JSON.stringify(unsaved)) > 128 * 1024
  )
    throw mcpSecretError('MCP_SECRET_SCOPE_MISMATCH');
  return {
    ...authority,
    projectId: claims.projectId,
    overrides: { [claims.overrideTier]: unsaved },
    verification: true,
  };
};

export const authorizeMcpSecretRequest = async (
  request,
  {
    ddbClient,
    ssmClient,
    env = process.env,
    now = Date.now,
    verifyGrant = verifyBrokerGatewayGrant,
  } = {},
) => {
  if (
    !isMcpRecord(request) ||
    request.action !== 'resolve-mcp-secrets' ||
    Object.keys(request).some((key) => !REQUEST_KEYS.includes(key))
  )
    throw mcpSecretError('MCP_SECRET_REQUEST_INVALID');
  if (Object.hasOwn(request, 'gatewayGrant') === Object.hasOwn(request, 'verificationGrant'))
    throw mcpSecretError('MCP_SECRET_AUTHORITY_REQUIRED');
  if (!engineDataEnabled(env)) throw mcpSecretError('MCP_SECRETS_DISABLED');
  const authority = Object.hasOwn(request, 'gatewayGrant')
    ? await stageAuthority(request, { ddbClient, env, verifyGrant })
    : await verificationAuthority(request, { ssmClient, env, now });
  const { policy, survivingGlobal, survivingProject, projectId, overrides, verification } =
    authority;
  const base = env.AGENT_SETTINGS_SSM_PREFIX;
  if (
    typeof base !== 'string' ||
    !/^\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+$/.test(base) ||
    base.split('/').some((part) => part === '.' || part === '..')
  )
    throw mcpSecretError('MCP_SECRET_NOT_CONFIGURED');

  // Stage failure must precede all reads; verification keeps unrelated servers usable.
  if (!verification && policy.reservedRefs.size) throw mcpSecretError('MCP_SECRET_RESERVED');
  if (!verification && policy.collidingRefs.size) throw mcpSecretError('MCP_SECRET_COLLISION');
  const secretEnv = {};
  const results = {};
  for (const [tier, servers] of [
    ['global', survivingGlobal],
    ['project', survivingProject],
  ]) {
    const values = new Map();
    for (const name of Object.keys(servers)) {
      const refs = policy.refsByServer[name];
      let code = refs.some((ref) => policy.reservedRefs.has(ref))
        ? 'MCP_SECRET_RESERVED'
        : refs.some((ref) => policy.collidingRefs.has(ref))
          ? 'MCP_SECRET_COLLISION'
          : null;
      if (!code) {
        for (const ref of refs) {
          if (!values.has(ref)) {
            if (Object.hasOwn(overrides[tier] ?? {}, ref)) {
              values.set(ref, { value: overrides[tier][ref] });
            } else {
              try {
                const res = await ssmClient.send(
                  new GetParameterCommand({
                    Name: `${mcpSecretsBase({ base, projectId: tier === 'project' ? projectId : null })}/${ref}`,
                    WithDecryption: true,
                  }),
                );
                values.set(
                  ref,
                  typeof res.Parameter?.Value === 'string'
                    ? { value: res.Parameter.Value }
                    : { code: 'MCP_SECRET_MISSING' },
                );
              } catch (error) {
                values.set(ref, {
                  code:
                    error?.name === 'ParameterNotFound'
                      ? 'MCP_SECRET_MISSING'
                      : 'MCP_SECRET_READ_FAILED',
                });
              }
            }
          }
          if (values.get(ref).code) {
            code = values.get(ref).code;
            break;
          }
        }
      }
      if (code) {
        if (!verification) throw mcpSecretError(code);
        results[name] = failure(code);
      } else {
        results[name] = { ok: true };
        for (const ref of refs) secretEnv[ref] = values.get(ref).value;
      }
    }
  }
  return verification ? { ok: true, secretEnv, results } : { ok: true, secretEnv };
};
