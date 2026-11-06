import { createHmac, timingSafeEqual } from 'node:crypto';
import { authError } from './agent-auth-contracts.js';

export const INVOCATION_ACCOUNTING_AUDIENCE = 'aidlc-invocation-accounting';
export const INVOCATION_ACCOUNTING_TTL_SECONDS = 86_400;
const CLAIM_KEYS = ['audience', 'invocationId', 'issuedAt', 'expiresAt'];
const invalid = () =>
  authError('INVOCATION_TICKET_INVALID', 'Invocation accounting ticket is invalid');
const signature = (encoded, secret) => {
  if (typeof secret !== 'string' || Buffer.byteLength(secret) < 32)
    throw authError(
      'AGENT_CREDENTIAL_GRANT_NOT_CONFIGURED',
      'Credential grant secret is not configured',
    );
  return createHmac('sha256', secret).update(encoded).digest();
};
const validate = (claims, now) => {
  if (
    !claims ||
    typeof claims !== 'object' ||
    Array.isArray(claims) ||
    Object.keys(claims).length !== CLAIM_KEYS.length ||
    Object.keys(claims).some((key) => !CLAIM_KEYS.includes(key)) ||
    claims.audience !== INVOCATION_ACCOUNTING_AUDIENCE ||
    typeof claims.invocationId !== 'string' ||
    !/^[a-f0-9]{64}$/.test(claims.invocationId) ||
    !Number.isSafeInteger(claims.issuedAt) ||
    !Number.isSafeInteger(claims.expiresAt) ||
    claims.issuedAt < 0 ||
    claims.issuedAt > Math.floor(now() / 1000) ||
    claims.expiresAt <= claims.issuedAt ||
    claims.expiresAt - claims.issuedAt > INVOCATION_ACCOUNTING_TTL_SECONDS
  )
    throw invalid();
  if (claims.expiresAt <= Math.floor(now() / 1000))
    throw authError('INVOCATION_TICKET_EXPIRED', 'Invocation accounting ticket has expired');
  return claims;
};

export const signInvocationAccountingTicket = (claims, secret, { now = Date.now } = {}) => {
  const payload = validate({ audience: INVOCATION_ACCOUNTING_AUDIENCE, ...claims }, now);
  const encoded = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${encoded}.${signature(encoded, secret).toString('base64url')}`;
};

export const verifyInvocationAccountingTicket = (ticket, secret, { now = Date.now } = {}) => {
  if (
    typeof ticket !== 'string' ||
    ticket.length > 2048 ||
    !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(ticket)
  )
    throw invalid();
  const [encoded, supplied] = ticket.split('.');
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
