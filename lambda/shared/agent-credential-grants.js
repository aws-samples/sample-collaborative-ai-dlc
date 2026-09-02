import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { GetParameterCommand } from '@aws-sdk/client-ssm';
import { AGENT_CREDENTIAL_PROVIDERS, normalizeCredentialBinding } from './agent-credentials.js';
import { AGENT_AUTH_MODES } from './agent-command-registry.js';

export const AGENT_CREDENTIAL_GRANT_AUDIENCE = 'aidlc-agent-credential-broker';
export const AGENT_CREDENTIAL_GRANT_PURPOSES = Object.freeze(Object.values(AGENT_AUTH_MODES));
export const AGENT_CREDENTIAL_GRANT_TTL_SECONDS = 300;

const MAX_TOKEN_BYTES = 8192;
const CLOCK_SKEW_SECONDS = 30;
const secretCache = new Map();

const grantError = (code, message) => Object.assign(new Error(message), { code });

const requiredString = (value, label) => {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!normalized) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', `${label} is required`);
  }
  return normalized;
};

const normalizeGrantBindings = (bindings) => {
  const values = Array.isArray(bindings)
    ? bindings
    : bindings && typeof bindings === 'object'
      ? Object.values(bindings)
      : [];
  if (values.length < 1 || values.length > AGENT_CREDENTIAL_PROVIDERS.length) {
    throw grantError(
      'AGENT_CREDENTIAL_GRANT_INVALID',
      'Agent credential grant bindings are invalid',
    );
  }
  const normalized = values.map((binding) => {
    try {
      return normalizeCredentialBinding(binding);
    } catch {
      throw grantError(
        'AGENT_CREDENTIAL_GRANT_INVALID',
        'Agent credential grant binding is invalid',
      );
    }
  });
  const providers = new Set(normalized.map((binding) => binding.provider));
  if (providers.size !== normalized.length) {
    throw grantError(
      'AGENT_CREDENTIAL_GRANT_INVALID',
      'Agent credential grant providers must be unique',
    );
  }
  return normalized.toSorted(
    (left, right) =>
      AGENT_CREDENTIAL_PROVIDERS.indexOf(left.provider) -
      AGENT_CREDENTIAL_PROVIDERS.indexOf(right.provider),
  );
};

const signingKey = (secret) => {
  const key = Buffer.from(typeof secret === 'string' ? secret : '');
  if (key.length < 32) {
    throw grantError(
      'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
      'Agent credential grant secret is not configured',
    );
  }
  return key;
};

const signatureFor = (encodedClaims, secret) =>
  createHmac('sha256', signingKey(secret)).update(encodedClaims).digest();

const normalizedClaims = (claims) => {
  if (!claims || typeof claims !== 'object' || Array.isArray(claims)) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  const purpose = requiredString(claims.purpose, 'purpose');
  if (!AGENT_CREDENTIAL_GRANT_PURPOSES.includes(purpose)) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant purpose is invalid');
  }
  const projectId =
    claims.projectId === null || claims.projectId === undefined
      ? null
      : requiredString(claims.projectId, 'projectId');
  const executionId =
    claims.executionId === null || claims.executionId === undefined
      ? null
      : requiredString(claims.executionId, 'executionId');
  const bindings = normalizeGrantBindings(claims.bindings);
  if (bindings.some((binding) => binding.source === 'space') && !projectId) {
    throw grantError(
      'AGENT_CREDENTIAL_GRANT_INVALID',
      'Space credential grants require a projectId',
    );
  }
  return {
    version: 1,
    audience: AGENT_CREDENTIAL_GRANT_AUDIENCE,
    grantId: requiredString(claims.grantId, 'grantId'),
    purpose,
    projectId,
    executionId,
    bindings,
    issuedAt: Number(claims.issuedAt),
    expiresAt: Number(claims.expiresAt),
  };
};

export const signAgentCredentialGrant = (
  { purpose, projectId = null, executionId = null, bindings },
  secret,
  {
    now = () => Date.now(),
    randomId = randomUUID,
    ttlSeconds = AGENT_CREDENTIAL_GRANT_TTL_SECONDS,
  } = {},
) => {
  if (
    !Number.isInteger(ttlSeconds) ||
    ttlSeconds < 1 ||
    ttlSeconds > AGENT_CREDENTIAL_GRANT_TTL_SECONDS
  ) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant TTL is invalid');
  }
  const issuedAt = Math.floor(now() / 1000);
  const claims = normalizedClaims({
    purpose,
    projectId,
    executionId,
    bindings,
    grantId: randomId(),
    issuedAt,
    expiresAt: issuedAt + ttlSeconds,
  });
  const encodedClaims = Buffer.from(JSON.stringify(claims)).toString('base64url');
  const signature = signatureFor(encodedClaims, secret).toString('base64url');
  return `${encodedClaims}.${signature}`;
};

export const verifyAgentCredentialGrant = (token, secret, { now = () => Date.now() } = {}) => {
  if (typeof token !== 'string' || !token || Buffer.byteLength(token) > MAX_TOKEN_BYTES) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  const parts = token.split('.');
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  const [encodedClaims, encodedSignature] = parts;
  let suppliedSignature;
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url');
  } catch {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  const expectedSignature = signatureFor(encodedClaims, secret);
  if (
    suppliedSignature.length !== expectedSignature.length ||
    !timingSafeEqual(suppliedSignature, expectedSignature)
  ) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }

  let parsed;
  try {
    parsed = JSON.parse(Buffer.from(encodedClaims, 'base64url').toString('utf8'));
  } catch {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  if (parsed?.version !== 1 || parsed?.audience !== AGENT_CREDENTIAL_GRANT_AUDIENCE) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  const claims = normalizedClaims(parsed);
  const current = Math.floor(now() / 1000);
  if (
    !Number.isInteger(claims.issuedAt) ||
    !Number.isInteger(claims.expiresAt) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > AGENT_CREDENTIAL_GRANT_TTL_SECONDS ||
    claims.issuedAt > current + CLOCK_SKEW_SECONDS
  ) {
    throw grantError('AGENT_CREDENTIAL_GRANT_INVALID', 'Agent credential grant is invalid');
  }
  if (claims.expiresAt <= current) {
    throw grantError('AGENT_CREDENTIAL_GRANT_EXPIRED', 'Agent credential grant has expired');
  }
  return claims;
};

export const loadAgentCredentialGrantSecret = async (ssm, { env = process.env } = {}) => {
  if (env.AGENT_CREDENTIAL_GRANT_SECRET) {
    return signingKey(env.AGENT_CREDENTIAL_GRANT_SECRET).toString('utf8');
  }
  const parameterName = env.AGENT_CREDENTIAL_GRANT_SECRET_PARAM;
  if (!parameterName || !ssm?.send) {
    throw grantError(
      'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
      'Agent credential grant secret is not configured',
    );
  }
  if (secretCache.has(parameterName)) return secretCache.get(parameterName);
  const result = await ssm.send(
    new GetParameterCommand({
      Name: parameterName,
      WithDecryption: true,
    }),
  );
  const secret = result.Parameter?.Value || '';
  signingKey(secret);
  secretCache.set(parameterName, secret);
  return secret;
};

export const issueAgentCredentialGrant = async (
  ssm,
  claims,
  { env = process.env, secret = null, ...options } = {},
) =>
  signAgentCredentialGrant(
    claims,
    secret ?? (await loadAgentCredentialGrantSecret(ssm, { env })),
    options,
  );

export const verifyIssuedAgentCredentialGrant = async (
  ssm,
  token,
  { env = process.env, secret = null, ...options } = {},
) =>
  verifyAgentCredentialGrant(
    token,
    secret ?? (await loadAgentCredentialGrantSecret(ssm, { env })),
    options,
  );

export default {
  issueAgentCredentialGrant,
  loadAgentCredentialGrantSecret,
  signAgentCredentialGrant,
  verifyAgentCredentialGrant,
  verifyIssuedAgentCredentialGrant,
};
