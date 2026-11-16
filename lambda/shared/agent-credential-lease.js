import { authError, assertIdentifier, normalizeEndpoint } from './agent-auth-protocol.js';

// Wire contract between a broker provider and its runtime adapter. Material is
// opaque to grant verification and session ownership. Times are epoch milliseconds.
export const normalizeCredentialLease = (lease) => {
  const invalid = () => {
    throw authError('AGENT_AUTH_LEASE_INVALID', 'Credential lease is invalid');
  };
  if (!lease || lease.version !== 1) return invalid();
  const material = lease.material ?? null;
  if (material !== null) {
    if (typeof material !== 'object' || Array.isArray(material)) return invalid();
    assertIdentifier(material.type, 'credential material type');
  }
  const expiresAt = lease.expiresAt ?? null;
  const authorizationExpiresAt = lease.authorizationExpiresAt ?? null;
  for (const deadline of [expiresAt, authorizationExpiresAt])
    if (deadline !== null && (!Number.isSafeInteger(deadline) || deadline <= 0)) return invalid();
  const renewal = lease.renewal ?? null;
  if (
    renewal &&
    (typeof renewal.grant !== 'string' ||
      !renewal.grant ||
      !expiresAt ||
      !authorizationExpiresAt ||
      expiresAt > authorizationExpiresAt)
  )
    return invalid();
  if (renewal?.action) assertIdentifier(renewal.action, 'renewal action');
  if (renewal && Object.keys(renewal).some((key) => !['grant', 'action'].includes(key)))
    return invalid();
  return {
    version: 1,
    material: material ? { ...material } : null,
    expiresAt,
    authorizationExpiresAt,
    renewal: renewal
      ? {
          grant: renewal.grant,
          ...(renewal.action ? { action: renewal.action } : {}),
        }
      : null,
  };
};

export const apiKeyLease = (value) =>
  normalizeCredentialLease({
    version: 1,
    material: value ? { type: 'api-key', value } : null,
  });

// ── Bedrock gateway ──
// A deployment can send API-key inference to a gateway in place of Amazon Bedrock
// (BEDROCK_GATEWAY_URL, Terraform bedrock_gateway_url). Every Bedrock API key is then a key of
// that gateway. The broker says so in the lease: the key leaves it as this material, which
// names the gateway, and never as api-key material. A runtime that does not know the type, or
// is configured for another endpoint, refuses the lease, so what a key is for never depends on
// the runtime's own configuration alone.
export const BEDROCK_GATEWAY_KEY_MATERIAL = 'bedrock-gateway-key';

// An invalid URL throws rather than reading as "no gateway", which would send keys to AWS.
export const bedrockGatewayUrl = (env = {}) =>
  env.BEDROCK_GATEWAY_URL
    ? normalizeEndpoint(env.BEDROCK_GATEWAY_URL, 'Bedrock gateway URL')
    : null;

// The api-key lease of a Bedrock key, as a lease for the gateway at `endpoint`.
export const bedrockGatewayKeyLease = (lease, endpoint) =>
  normalizeCredentialLease({
    ...lease,
    material: { type: BEDROCK_GATEWAY_KEY_MATERIAL, value: lease.material.value, endpoint },
  });
