// Standalone ESM copy of `lambda/shared/realtime-token.js` for the Yjs server.
//
// The Yjs Docker build context is `lambda/yjs-server` only, so it cannot
// import from `lambda/shared`. This file MUST stay behaviorally identical to
// the shared module — `test/realtime-token.test.js` pins both implementations
// against the same vector table. If you change anything here, mirror it in
// `lambda/shared/realtime-token.js`.

import crypto from 'node:crypto';

export const TOKEN_TTL_SECONDS = 600; // 10 minutes
const TOKEN_VERSION = 1;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const hmac = (payloadB64, secret) =>
  crypto.createHmac('sha256', secret).update(payloadB64).digest();

export const signRealtimeToken = (
  { sub, scopes, ttlSeconds = TOKEN_TTL_SECONDS, now = Date.now() },
  secret,
) => {
  if (!sub) throw new Error('signRealtimeToken: sub is required');
  if (!Array.isArray(scopes) || scopes.length === 0) {
    throw new Error('signRealtimeToken: scopes must be a non-empty array');
  }
  if (!secret) throw new Error('signRealtimeToken: secret is required');

  const iat = Math.floor(now / 1000);
  const exp = iat + ttlSeconds;
  const payloadB64 = b64url(JSON.stringify({ v: TOKEN_VERSION, sub, scopes, iat, exp }));
  const token = `${payloadB64}.${b64url(hmac(payloadB64, secret))}`;
  return { token, exp, scopes };
};

export const verifyRealtimeToken = (token, secret, { now = Date.now() } = {}) => {
  if (!secret) return { ok: false, reason: 'no_secret' };
  if (typeof token !== 'string' || token.length === 0 || token.length > 4096) {
    return { ok: false, reason: 'malformed' };
  }
  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) return { ok: false, reason: 'malformed' };

  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  let givenSig;
  try {
    givenSig = Buffer.from(sigB64, 'base64url');
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  const expectedSig = hmac(payloadB64, secret);
  if (givenSig.length !== expectedSig.length || !crypto.timingSafeEqual(givenSig, expectedSig)) {
    return { ok: false, reason: 'bad_signature' };
  }

  let payload;
  try {
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return { ok: false, reason: 'malformed' };
  }
  if (!payload || payload.v !== TOKEN_VERSION || !payload.sub || !Array.isArray(payload.scopes)) {
    return { ok: false, reason: 'malformed' };
  }
  if (typeof payload.exp !== 'number' || payload.exp * 1000 <= now) {
    return { ok: false, reason: 'expired' };
  }
  return { ok: true, payload };
};

export const verifyRealtimeAccess = ({ token, secret, requiredScope, sub, now = Date.now() }) => {
  if (!requiredScope) return { ok: false, reason: 'unknown_scope' };
  if (!token) return { ok: false, reason: 'missing_token' };
  const verified = verifyRealtimeToken(token, secret, { now });
  if (!verified.ok) return verified;
  if (!verified.payload.scopes.includes(requiredScope)) {
    return { ok: false, reason: 'scope_mismatch' };
  }
  if (!sub || verified.payload.sub !== sub) {
    return { ok: false, reason: 'sub_mismatch' };
  }
  return verified;
};

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SPRINT_DOC_RE = new RegExp(
  `^(?:presence|sq|requirement|userstory|task|review|discussion)-(${UUID_PATTERN})(?:-.+)?$`,
);
const PROJECT_DOC_RE = new RegExp(`^inception-(${UUID_PATTERN})$`);
const SPRINT_CHANNEL_RE = new RegExp(`^sprint:(${UUID_PATTERN})$`);
const PROJECT_CHANNEL_RE = new RegExp(`^${UUID_PATTERN}$`);

export const requiredScopeForYjsDoc = (docName) => {
  if (typeof docName !== 'string') return null;
  const sprint = SPRINT_DOC_RE.exec(docName);
  if (sprint) return `sprint:${sprint[1].toLowerCase()}`;
  const project = PROJECT_DOC_RE.exec(docName);
  if (project) return `project:${project[1].toLowerCase()}`;
  return null;
};

export const requiredScopeForChannel = (documentId) => {
  if (typeof documentId !== 'string') return null;
  const sprint = SPRINT_CHANNEL_RE.exec(documentId);
  if (sprint) return `sprint:${sprint[1].toLowerCase()}`;
  if (PROJECT_CHANNEL_RE.test(documentId)) return `project:${documentId.toLowerCase()}`;
  return null;
};

export const isTokenLive = (tokenExp, now = Date.now()) => {
  if (tokenExp === undefined || tokenExp === null || tokenExp === '') return true;
  const exp = Number(tokenExp);
  if (!Number.isFinite(exp)) return true;
  return exp * 1000 > now;
};
