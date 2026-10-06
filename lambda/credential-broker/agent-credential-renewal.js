import { authError } from '../shared/agent-auth-protocol.js';
import { AGENT_AUTH_MODES } from '../shared/agent-command-registry.js';
import { signCredentialToken, verifyCredentialToken } from '../shared/agent-credential-grants.js';
import { normalizeCredentialLease } from '../shared/agent-credential-lease.js';

// A connection-verification grant never carries renewal authority.
const { VERIFY_CONNECTION } = AGENT_AUTH_MODES;

const invalidRenewal = () =>
  authError('AGENT_CREDENTIAL_GRANT_INVALID', 'Renewal requires one pinned connection');

// A renewal token is the handoff grant re-signed under the provider's audience: it keeps
// grantId, carries only the renewing binding and ends issuedAt + ttlSeconds after the handoff.
// Tokens already in flight keep verifying only while these claims stay byte-identical.
export const signRenewal = ({ claims, binding, policy, key }) => {
  if (binding?.version !== 2 || claims.purpose === VERIFY_CONNECTION) throw invalidRenewal();
  return signCredentialToken(
    { ...claims, bindings: [binding], expiresAt: claims.issuedAt + policy.ttlSeconds },
    key,
    policy.audience,
  );
};

export const verifyRenewal = ({ token, key, policy, owns, now }) => {
  const claims = verifyCredentialToken(token, key, {
    now,
    audience: policy.audience,
    ttl: policy.ttlSeconds,
  });
  if (
    claims.version !== 2 ||
    claims.bindings.length !== 1 ||
    !owns(claims.bindings[0]) ||
    claims.purpose === VERIFY_CONNECTION
  )
    throw invalidRenewal();
  return claims;
};

// Authorization never slides: a renewal presents the same token and keeps the deadline fixed
// by the handoff, so material expiry can only shorten a lease.
export const composeLease = ({
  material = null,
  expiresAt = null,
  claims,
  request,
  policy = null,
  presentedToken = null,
  issueRenewal,
}) => {
  const token =
    request === 'resolve' && policy && material
      ? issueRenewal()
      : request === 'renew'
        ? presentedToken
        : null;
  const authorizationExpiresAt =
    request === 'resolve' && policy
      ? (claims.issuedAt + policy.ttlSeconds) * 1000
      : request === 'renew' || request === 'verify'
        ? claims.expiresAt * 1000
        : null;
  const deadlines = [expiresAt, authorizationExpiresAt].filter((deadline) => deadline !== null);
  return normalizeCredentialLease({
    version: 1,
    material,
    expiresAt: deadlines.length ? Math.min(...deadlines) : null,
    authorizationExpiresAt,
    renewal: token ? { grant: token, action: policy.action } : null,
  });
};
