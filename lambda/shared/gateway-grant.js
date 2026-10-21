// Gateway grant: the control plane's signed statement of which space, intent,
// execution and (optionally) stage an AgentCore invocation may touch through
// the built-in MCP Gateway.
//
// Issued by a Lambda OUTSIDE the runtime (orchestrator / discussions) and
// verified by the MCP tools Lambda behind AgentCore Gateway. The runtime only
// relays it, so code running in the agent's VM cannot mint a grant for another
// space. It is a compact ES256 JWT. Using it as the Gateway's CUSTOM_JWT inbound
// credential would need an OIDC discovery document and JWKS for the KMS key, an
// issuer and algorithm the authorizer accepts, and the same live checks behind
// it: the native authorizer validates the token, not the execution's state.
//
// Signing is injected: production signs with an asymmetric KMS key (the private
// key never leaves KMS and verifiers hold only the public key); tests sign with
// a local P-256 key through the same seam.
import { createHash, createPublicKey, randomUUID, verify as cryptoVerify } from 'node:crypto';
import { canonicalJson } from './workflow-checkpoint.js';
import { GRANT_SCOPES, commandDefinition } from './agent-command-registry.js';

export const GATEWAY_GRANT_ISSUER = 'aidlc-control-plane';
export const GATEWAY_GRANT_AUDIENCE = 'aidlc-gateway';
// Bounded by the AgentCore runtime's 8h maximum session lifetime. Revocation is
// per call (the verifier re-checks execution/stage state), not expiry.
export const GATEWAY_GRANT_MAX_TTL_SECONDS = 8 * 60 * 60;
// `execution` authorizes engine data access for one execution and no stage; it
// is never accepted by the MCP tools Lambda.
export const GATEWAY_GRANT_MODES = Object.freeze(['stage', 'discussion', 'conflict', 'execution']);
// Discussion assists have no execution/stage row to re-check per call, so their
// grant must expire on its own, quickly.
export const DISCUSSION_GRANT_TTL_SECONDS = 300;
// A compose job (compose-plan-start) runs in the background after the runtime
// accepts it and the control plane does not observe its end, so its grant must
// also expire on its own: catalog and graph reads, one composer CLI call bounded
// by the one-shot timeout (120s), validation and the result write fit well
// inside 15 minutes (agentcore/test/compose-plan-start.test.js pins the bound).
export const COMPOSE_GRANT_TTL_SECONDS = 15 * 60;
const CLOCK_SKEW_SECONDS = 60;
const MAX_TOKEN_BYTES = 4096;

export class GatewayGrantError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'GatewayGrantError';
    this.code = code;
  }
}

const invalid = () => new GatewayGrantError('GATEWAY_GRANT_INVALID', 'Gateway grant is invalid');

const optionalString = (value) => {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string') throw invalid();
  return value;
};

const optionalIndex = (value) => {
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 0) throw invalid();
  return value;
};

const requiredString = (value) => {
  if (typeof value !== 'string' || !value) throw invalid();
  return value;
};

// The scope a grant may carry. Anything else is dropped at issue and rejected at
// verify, so a claim cannot silently widen what the verifier trusts.
export const normalizeGatewayScope = (input = {}) => {
  const mode = input.mode ?? 'stage';
  if (!GATEWAY_GRANT_MODES.includes(mode)) throw invalid();
  const scope = {
    mode,
    projectId: requiredString(input.projectId),
    intentId: requiredString(input.intentId),
    executionId: optionalString(input.executionId),
    stageId: optionalString(input.stageId),
    unitSlug: optionalString(input.unitSlug),
    sectionIndex: optionalIndex(input.sectionIndex),
    policyDigest: optionalString(input.policyDigest),
    // The stage leg this dispatch opened. Signed so a session cannot drop or
    // rewrite them to keep acting after its leg is superseded.
    stageCallbackId: optionalString(input.stageCallbackId),
    orchestratorRunId: optionalString(input.orchestratorRunId),
  };
  if (mode !== 'discussion' && !scope.executionId) throw invalid();
  if (mode !== 'stage' && (scope.stageId || scope.stageCallbackId || scope.orchestratorRunId)) {
    throw invalid();
  }
  // Discussion and execution grants span the whole intent/execution, so a lane
  // selector would only suggest a narrowing no verifier enforces.
  if (
    (mode === 'discussion' || mode === 'execution') &&
    (scope.unitSlug || scope.sectionIndex !== null)
  ) {
    throw invalid();
  }
  return scope;
};

// The resolved release policy decides which checkpoint/learning tools a session
// gets, so it is an authorization input: the grant pins its digest and the
// verifier rejects a session presenting any other policy.
export const gatewayPolicyDigest = (policy) =>
  policy && typeof policy === 'object'
    ? createHash('sha256').update(canonicalJson(policy)).digest('hex')
    : null;

const b64 = (value) => Buffer.from(value).toString('base64url');
const json = (value) => b64(JSON.stringify(value));

// KMS returns ECDSA signatures DER-encoded; JWS ES256 uses raw r||s (64 bytes).
export const derToJose = (der) => {
  const buf = Buffer.from(der);
  if (buf[0] !== 0x30) throw invalid();
  let offset = 2;
  if (buf[1] & 0x80) offset = 2 + (buf[1] & 0x7f);
  const readInt = () => {
    if (buf[offset] !== 0x02) throw invalid();
    const length = buf[offset + 1];
    let value = buf.subarray(offset + 2, offset + 2 + length);
    offset += 2 + length;
    while (value.length > 32 && value[0] === 0) value = value.subarray(1);
    if (value.length > 32) throw invalid();
    return Buffer.concat([Buffer.alloc(32 - value.length), value]);
  };
  return Buffer.concat([readInt(), readInt()]);
};

// The grant scope a runtime command needs, from its registry `grantScope`.
// Identity comes from the caller's authoritative record; only the lane/stage
// selectors the control plane itself put in the command are read from it.
// Discussion grants are issued by the discussions Lambda, so they map to null
// here like commands that need no grant.
export const gatewayScopeForCommand = (
  payload,
  { projectId, intentId, executionId, policy = null },
) => {
  switch (commandDefinition(payload?.command)?.grantScope) {
    case GRANT_SCOPES.STAGE:
      return {
        mode: 'stage',
        projectId,
        intentId,
        executionId,
        stageId: payload.stageId,
        unitSlug: payload.unitSlug,
        sectionIndex: payload.sectionIndex,
        policyDigest: gatewayPolicyDigest(policy),
        stageCallbackId: payload.stageCallbackId,
        orchestratorRunId: payload.orchestratorRunId,
      };
    case GRANT_SCOPES.CONFLICT:
      return {
        mode: 'conflict',
        projectId,
        intentId,
        executionId,
        unitSlug: payload.unitSlug,
        sectionIndex: payload.sectionIndex,
      };
    case GRANT_SCOPES.EXECUTION:
      return { mode: 'execution', projectId, intentId, executionId };
    default:
      return null;
  }
};

export const issueGatewayGrant = async (
  scopeInput,
  {
    sign,
    keyId,
    ttlSeconds = GATEWAY_GRANT_MAX_TTL_SECONDS,
    now = Date.now,
    randomId = randomUUID,
  },
) => {
  if (typeof sign !== 'function' || !keyId) {
    throw new GatewayGrantError(
      'GATEWAY_GRANT_NOT_CONFIGURED',
      'Gateway grant signer is not configured',
    );
  }
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > GATEWAY_GRANT_MAX_TTL_SECONDS
  ) {
    throw invalid();
  }
  const scope = normalizeGatewayScope(scopeInput);
  const iat = Math.floor(now() / 1000);
  const header = { alg: 'ES256', typ: 'JWT', kid: keyId };
  const payload = {
    iss: GATEWAY_GRANT_ISSUER,
    aud: GATEWAY_GRANT_AUDIENCE,
    sub: scope.executionId ?? `intent:${scope.intentId}`,
    jti: randomId(),
    iat,
    exp: iat + ttlSeconds,
    ...scope,
  };
  const signingInput = `${json(header)}.${json(payload)}`;
  const signature = derToJose(await sign(Buffer.from(signingInput)));
  return `${signingInput}.${signature.toString('base64url')}`;
};

const parsePart = (part) => {
  try {
    const value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw invalid();
    return value;
  } catch {
    throw invalid();
  }
};

// `publicKeyFor(kid) -> Promise<KeyObject | DER SPKI | PEM>`: the verifier's
// trust anchor. An unknown kid must reject.
// `isRetired({ grantId, executionId, issuedAt }) -> Promise<boolean>`: the
// control plane's retirement records (gateway-grant-retirement.js) for this jti
// and for every grant of its execution issued up to a point in time. Consulted
// only for a grant that is otherwise valid; a lookup failure rejects the grant
// (fail closed).
export const verifyGatewayGrant = async (
  token,
  { publicKeyFor, now = Date.now, isRetired = null },
) => {
  if (typeof token !== 'string' || !token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw invalid();
  }
  const parts = token.split('.');
  if (parts.length !== 3 || parts.some((p) => !p)) throw invalid();
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  const header = parsePart(encodedHeader);
  if (
    header.alg !== 'ES256' ||
    header.typ !== 'JWT' ||
    typeof header.kid !== 'string' ||
    !header.kid
  ) {
    throw invalid();
  }
  let key;
  try {
    const material = await publicKeyFor(header.kid);
    if (!material) throw invalid();
    key =
      typeof material === 'object' && material.type === 'public'
        ? material
        : createPublicKey(
            Buffer.isBuffer(material) || material instanceof Uint8Array
              ? { key: Buffer.from(material), format: 'der', type: 'spki' }
              : material,
          );
  } catch {
    throw invalid();
  }
  const signature = Buffer.from(encodedSignature, 'base64url');
  const valid =
    signature.length === 64 &&
    cryptoVerify(
      'sha256',
      Buffer.from(`${encodedHeader}.${encodedPayload}`),
      { key, dsaEncoding: 'ieee-p1363' },
      signature,
    );
  if (!valid) throw invalid();

  const payload = parsePart(encodedPayload);
  const allowed = new Set([
    'iss',
    'aud',
    'sub',
    'jti',
    'iat',
    'exp',
    'mode',
    'projectId',
    'intentId',
    'executionId',
    'stageId',
    'unitSlug',
    'sectionIndex',
    'policyDigest',
    'stageCallbackId',
    'orchestratorRunId',
  ]);
  if (Object.keys(payload).some((k) => !allowed.has(k))) throw invalid();
  if (payload.iss !== GATEWAY_GRANT_ISSUER || payload.aud !== GATEWAY_GRANT_AUDIENCE)
    throw invalid();
  if (typeof payload.jti !== 'string' || !payload.jti) throw invalid();
  const current = Math.floor(now() / 1000);
  if (
    !Number.isInteger(payload.iat) ||
    !Number.isInteger(payload.exp) ||
    payload.exp <= payload.iat ||
    payload.exp - payload.iat > GATEWAY_GRANT_MAX_TTL_SECONDS ||
    payload.iat > current + CLOCK_SKEW_SECONDS
  ) {
    throw invalid();
  }
  if (payload.exp <= current) {
    throw new GatewayGrantError('GATEWAY_GRANT_EXPIRED', 'Gateway grant has expired');
  }
  const scope = normalizeGatewayScope(payload);
  if (payload.sub !== (scope.executionId ?? `intent:${scope.intentId}`)) throw invalid();
  if (typeof isRetired === 'function') {
    let retired;
    try {
      retired = await isRetired({
        grantId: payload.jti,
        executionId: scope.executionId,
        issuedAt: payload.iat,
      });
    } catch {
      throw new GatewayGrantError(
        'GATEWAY_GRANT_RETIREMENT_UNAVAILABLE',
        'Gateway grant retirement could not be checked',
      );
    }
    if (retired !== false) {
      throw new GatewayGrantError('GATEWAY_GRANT_RETIRED', 'Gateway grant has been retired');
    }
  }
  return {
    ...scope,
    grantId: payload.jti,
    keyId: header.kid,
    issuedAt: payload.iat,
    expiresAt: payload.exp,
  };
};

export const kmsSigner =
  ({ kms, SignCommand, keyId }) =>
  async (message) => {
    const result = await kms.send(
      new SignCommand({
        KeyId: keyId,
        Message: message,
        MessageType: 'RAW',
        SigningAlgorithm: 'ECDSA_SHA_256',
      }),
    );
    return Buffer.from(result.Signature);
  };

// Public keys are immutable per KMS key id, so a process-lifetime cache is
// safe. Only key ids in `allowedKeyIds` are ever fetched: the token's kid is
// attacker-controlled input.
export const kmsPublicKeyResolver = ({ kms, GetPublicKeyCommand, allowedKeyIds }) => {
  const allowed = new Set(allowedKeyIds.filter(Boolean));
  const cache = new Map();
  return (kid) => {
    if (!allowed.has(kid)) return Promise.resolve(null);
    if (!cache.has(kid)) {
      const pending = kms
        .send(new GetPublicKeyCommand({ KeyId: kid }))
        .then((r) =>
          createPublicKey({ key: Buffer.from(r.PublicKey), format: 'der', type: 'spki' }),
        );
      pending.catch(() => cache.delete(kid));
      cache.set(kid, pending);
    }
    return cache.get(kid);
  };
};
