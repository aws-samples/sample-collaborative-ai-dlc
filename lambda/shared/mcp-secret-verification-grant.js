import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { loadAgentCredentialGrantSecret } from './agent-credential-grants.js';
import {
  isMcpProjectId,
  isMcpRecord,
  isMcpSecretRef,
  mcpSecretConfigAuthority,
  mcpSecretError,
} from './mcp-secret-config.js';

export const MCP_SECRET_VERIFICATION_AUDIENCE = 'aidlc-mcp-secret-verification';
export const MCP_SECRET_VERIFICATION_TTL_SECONDS = 300;
const CLAIM_KEYS = [
  'audience',
  'purpose',
  'grantId',
  'projectId',
  'configDigest',
  'allowedRefs',
  'overrideTier',
  'issuedAt',
  'expiresAt',
];
const invalid = () => mcpSecretError('MCP_VERIFICATION_GRANT_INVALID');
const signature = (encoded, secret) => {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw mcpSecretError('AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED');
  return createHmac('sha256', secret).update(encoded).digest();
};

const validate = (claims, now) => {
  if (
    !isMcpRecord(claims) ||
    Object.keys(claims).length !== CLAIM_KEYS.length ||
    Object.keys(claims).some((key) => !CLAIM_KEYS.includes(key)) ||
    claims.audience !== MCP_SECRET_VERIFICATION_AUDIENCE ||
    claims.purpose !== 'verify-mcp' ||
    typeof claims.grantId !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.grantId) ||
    (claims.projectId !== null && !isMcpProjectId(claims.projectId)) ||
    typeof claims.configDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(claims.configDigest) ||
    claims.overrideTier !== (claims.projectId === null ? 'global' : 'project') ||
    !isMcpRecord(claims.allowedRefs) ||
    Object.keys(claims.allowedRefs).length !== 2 ||
    Object.keys(claims.allowedRefs).some((key) => !['global', 'project'].includes(key)) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt < 0 ||
    claims.issuedAt > Math.floor(now() / 1000) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > MCP_SECRET_VERIFICATION_TTL_SECONDS
  )
    throw invalid();
  for (const tier of ['global', 'project']) {
    const refs = claims.allowedRefs[tier];
    if (
      !Array.isArray(refs) ||
      refs.length > 256 ||
      refs.some((ref) => !isMcpSecretRef(ref)) ||
      new Set(refs).size !== refs.length ||
      JSON.stringify(refs) !== JSON.stringify(refs.toSorted())
    )
      throw invalid();
  }
  if (claims.projectId === null && claims.allowedRefs.project.length) throw invalid();
  if (claims.expiresAt <= Math.floor(now() / 1000))
    throw mcpSecretError('MCP_VERIFICATION_GRANT_EXPIRED');
  return claims;
};

export const signMcpSecretVerificationGrant = (
  { projectId = null, mcpServersByTier },
  secret,
  { now = Date.now, randomId = randomUUID, ttlSeconds = MCP_SECRET_VERIFICATION_TTL_SECONDS } = {},
) => {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > MCP_SECRET_VERIFICATION_TTL_SECONDS
  )
    throw invalid();
  const { config, configDigest, allowedRefs } = mcpSecretConfigAuthority(mcpServersByTier);
  if (projectId === null && Object.keys(config.project).length) throw invalid();
  const issuedAt = Math.floor(now() / 1000);
  const claims = validate(
    {
      audience: MCP_SECRET_VERIFICATION_AUDIENCE,
      purpose: 'verify-mcp',
      grantId: randomId(),
      projectId,
      configDigest,
      allowedRefs,
      overrideTier: projectId === null ? 'global' : 'project',
      issuedAt,
      expiresAt: issuedAt + ttlSeconds,
    },
    now,
  );
  const encoded = Buffer.from(JSON.stringify(claims)).toString('base64url');
  return `${encoded}.${signature(encoded, secret).toString('base64url')}`;
};

export const verifyMcpSecretVerificationGrant = (token, secret, { now = Date.now } = {}) => {
  if (
    typeof token !== 'string' ||
    token.length > 128 * 1024 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)
  )
    throw invalid();
  const [encoded, supplied] = token.split('.');
  const expected = signature(encoded, secret);
  const actual = Buffer.from(supplied, 'base64url');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw invalid();
  let claims;
  try {
    claims = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
  return validate(claims, now);
};

export const issueMcpSecretVerificationGrant = async (
  ssm,
  claims,
  { env = process.env, ...options } = {},
) =>
  signMcpSecretVerificationGrant(
    claims,
    await loadAgentCredentialGrantSecret(ssm, { env }),
    options,
  );
