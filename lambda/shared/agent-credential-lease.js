import { authError, assertIdentifier } from './agent-auth-protocol.js';

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
  return {
    version: 1,
    material: material ? { ...material } : null,
    expiresAt,
    authorizationExpiresAt,
    renewal: renewal ? { grant: renewal.grant } : null,
  };
};

export const apiKeyLease = (value) =>
  normalizeCredentialLease({
    version: 1,
    material: value ? { type: 'api-key', value } : null,
  });
