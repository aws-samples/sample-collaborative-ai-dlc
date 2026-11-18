import { invokeCredentialBroker } from './clients.js';
import { currentGatewayGrant } from './mcp/gateway-context.js';
import { isMcpRecord, mcpSecretConfigAuthority } from '../shared/mcp-secret-config.js';
import { RESERVED_MCP_ENV_KEYS } from './mcp-secret-resolver.js';

const SAFE_FAILURES = {
  MCP_SECRET_RESERVED: 'A secret reference uses a reserved runtime variable. Rename it.',
  MCP_SECRET_COLLISION:
    'A secret reference is used in both tiers. Rename it or override the server by name.',
  MCP_SECRET_MISSING: 'A referenced secret is not set in its tier. Enter or save it, then retry.',
  MCP_SECRET_READ_FAILED: 'MCP secrets could not be read. Retry the verification.',
};
const failed = () =>
  Object.assign(new Error('MCP secret broker resolution failed'), {
    code: 'MCP_SECRET_BROKER_FAILED',
  });

const resolve = async (request, broker) => {
  try {
    const { policy } = mcpSecretConfigAuthority(request.mcpServersByTier);
    const result = await broker(request);
    const refs = new Set([...policy.globalRefs, ...policy.projectRefs]);
    if (
      result?.ok !== true ||
      !isMcpRecord(result.secretEnv) ||
      Object.entries(result.secretEnv).some(
        ([ref, value]) =>
          !refs.has(ref) ||
          RESERVED_MCP_ENV_KEYS.has(ref) ||
          policy.collidingRefs.has(ref) ||
          typeof value !== 'string',
      )
    )
      throw failed();
    if (!Object.hasOwn(request, 'verificationGrant')) {
      if ([...refs].some((ref) => !Object.hasOwn(result.secretEnv, ref))) throw failed();
      return { secretEnv: result.secretEnv };
    }
    const names = Object.keys(policy.refsByServer);
    if (!isMcpRecord(result.results) || Object.keys(result.results).length !== names.length)
      throw failed();
    const results = Object.fromEntries(
      names.map((name) => {
        const entry = result.results[name];
        if (entry?.ok === true) {
          if (policy.refsByServer[name].some((ref) => !Object.hasOwn(result.secretEnv, ref)))
            throw failed();
          return [name, { ok: true }];
        }
        if (entry?.ok !== false || !Object.hasOwn(SAFE_FAILURES, entry.code)) throw failed();
        return [name, { ok: false, code: entry.code, error: SAFE_FAILURES[entry.code] }];
      }),
    );
    return { secretEnv: result.secretEnv, results };
  } catch {
    // Lambda transport errors can embed the request, including the bearer token or overrides.
    throw failed();
  }
};

export const resolveStageMcpSecrets = (
  { projectId, mcpServersByTier },
  { broker = invokeCredentialBroker } = {},
) =>
  resolve(
    {
      action: 'resolve-mcp-secrets',
      gatewayGrant: currentGatewayGrant(),
      projectId,
      mcpServersByTier: mcpServersByTier ?? { global: {}, project: {} },
    },
    broker,
  );

export const resolveVerificationMcpSecrets = (
  { projectId = null, mcpServersByTier, verificationGrant, unsavedSecrets },
  { broker = invokeCredentialBroker } = {},
) =>
  resolve(
    {
      action: 'resolve-mcp-secrets',
      verificationGrant: verificationGrant ?? null,
      projectId,
      mcpServersByTier,
      ...(unsavedSecrets !== undefined ? { unsavedSecrets } : {}),
    },
    broker,
  );
