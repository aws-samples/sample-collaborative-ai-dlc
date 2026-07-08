// Shared HMAC-signed realtime scope tokens.
//
// Both realtime fabrics historically verified only "valid Cognito JWT", which
// let any signed-in user join any Yjs doc or app-WS scope. These short-lived
// scope tokens close that gap: they are issued by `lambda/discussions` after a
// membership check (Project -HAS_MEMBER-> User) and verified at connect time
// by the Yjs server and `lambda/ws-connection`.
//
// Token format:
//   base64url(JSON{ v, sub, scopes, iat, exp }) + "." + base64url(HMAC-SHA256(payloadB64, secret))
//
//   - `sub`    — Cognito sub the token is bound to (principal binding: the
//                verifier MUST compare it to the JWT-authenticated user).
//   - `scopes` — e.g. ["sprint:<sprintId>", "project:<projectId>"].
//   - `exp`    — epoch SECONDS; default TTL 10 minutes. Established sockets
//                are closed / filtered out at expiry.
//
// IMPORTANT: `lambda/yjs-server/realtime-token.js` is a standalone ESM copy of
// this module (the Yjs Docker build context cannot reach lambda/shared). The
// two are pinned in sync by `lambda/yjs-server/test/realtime-token.test.js`,
// which runs the same vector table against both implementations. If you change
// anything here, mirror it there.

import crypto from 'node:crypto';

const TOKEN_TTL_SECONDS = 600; // 10 minutes
const TOKEN_VERSION = 1;

const b64url = (buf) => Buffer.from(buf).toString('base64url');

const hmac = (payloadB64, secret) =>
  crypto.createHmac('sha256', secret).update(payloadB64).digest();

/**
 * Sign a realtime scope token.
 *
 * @param {{ sub: string, scopes: string[], ttlSeconds?: number, now?: number }} opts
 *        `now` is epoch milliseconds (test seam).
 * @param {string} secret
 * @returns {{ token: string, exp: number, scopes: string[] }}
 */
const signRealtimeToken = (
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

/**
 * Verify token integrity + expiry. Returns the decoded payload on success.
 * Scope coverage and principal binding are separate checks (see
 * `verifyRealtimeAccess`) so callers can log precise rejection reasons.
 *
 * @param {string} token
 * @param {string} secret
 * @param {{ now?: number }} [opts] `now` is epoch milliseconds.
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string }}
 */
const verifyRealtimeToken = (token, secret, { now = Date.now() } = {}) => {
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

/**
 * Full connect-path check: signature, expiry, scope coverage,
 * principal binding (`payload.sub === authenticated sub`).
 *
 * @param {{ token: string, secret: string, requiredScope: string|null, sub: string, now?: number }} opts
 * @returns {{ ok: true, payload: object } | { ok: false, reason: string }}
 */
const verifyRealtimeAccess = ({ token, secret, requiredScope, sub, now = Date.now() }) => {
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

// -----------------------------------------------------------------------------
// Doc-name / channel → required-scope extractors (deny-by-default).
//
// Sprint and project IDs are bare `randomUUID()` values (see lambda/sprints
// L129, lambda/projects L799), so the UUID shape is a safe parsing anchor even
// though doc names are dash-delimited.
//
// Yjs doc formats in the codebase (the inventory test enumerates them):
//   presence-{sprintId}                       usePresence.ts
//   sq-{sprintId}-{questionId}                useCollaborativeStructuredAnswer.ts
//   requirement-{sprintId}-{artifactId}       useCollaborativeArtifact.ts
//   userstory-{sprintId}-{artifactId}         useCollaborativeArtifact.ts
//   task-{sprintId}-{artifactId}              useCollaborativeArtifact.ts
//   review-{sprintId}-{artifactId|"pending"}  useCollaborativeArtifact.ts
//   discussion-{sprintId}-{discussionId}      (added by the discussions feature)
//   inception-{projectId}                     useCollaborativeInception.ts
//
// App-WS documentId formats:
//   sprint:{sprintId}   useSprintEvents.ts / useObservabilityEvents.ts
//   {projectId}         legacy server-side emitters (v1 engine, removed)
// -----------------------------------------------------------------------------

const UUID_PATTERN = '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}';
const SPRINT_DOC_RE = new RegExp(
  `^(?:presence|sq|requirement|userstory|task|review|discussion)-(${UUID_PATTERN})(?:-.+)?$`,
);
const PROJECT_DOC_RE = new RegExp(`^inception-(${UUID_PATTERN})$`);
const SPRINT_CHANNEL_RE = new RegExp(`^sprint:(${UUID_PATTERN})$`);
const PROJECT_CHANNEL_RE = new RegExp(`^${UUID_PATTERN}$`);
// V2 intent realtime. The intent app-WS channel is `intent:<intentId>` (see
// lambda/agentcore/clients.js broadcastToIntent). Intent collaboration Yjs docs
// use intent-specific prefixes (`intent-sq-…`, `intent-discussion-…`) so the
// extractor is unambiguous — sprintIds and intentIds are both bare UUIDs, so the
// shared v1 prefixes (`sq-`, `discussion-`) can't be reused without collision.
const INTENT_DOC_RE = new RegExp(`^intent-(?:sq|discussion|presence)-(${UUID_PATTERN})(?:-.+)?$`);
const INTENT_CHANNEL_RE = new RegExp(`^intent:(${UUID_PATTERN})$`);

/**
 * Yjs doc name → required scope, or null for unknown formats (deny).
 */
const requiredScopeForYjsDoc = (docName) => {
  if (typeof docName !== 'string') return null;
  // Intent docs first — their `intent-` prefix is more specific than the v1
  // `sq-`/`discussion-` shapes and must win.
  const intent = INTENT_DOC_RE.exec(docName);
  if (intent) return `intent:${intent[1].toLowerCase()}`;
  const sprint = SPRINT_DOC_RE.exec(docName);
  if (sprint) return `sprint:${sprint[1].toLowerCase()}`;
  const project = PROJECT_DOC_RE.exec(docName);
  if (project) return `project:${project[1].toLowerCase()}`;
  return null;
};

/**
 * App-WS documentId → required scope, or null for unknown formats (deny).
 */
const requiredScopeForChannel = (documentId) => {
  if (typeof documentId !== 'string') return null;
  const intent = INTENT_CHANNEL_RE.exec(documentId);
  if (intent) return `intent:${intent[1].toLowerCase()}`;
  const sprint = SPRINT_CHANNEL_RE.exec(documentId);
  if (sprint) return `sprint:${sprint[1].toLowerCase()}`;
  if (PROJECT_CHANNEL_RE.test(documentId)) return `project:${documentId.toLowerCase()}`;
  return null;
};

/**
 * Send-time liveness filter for connection rows: rows whose token
 * has expired must never be fan-out targets. Rows WITHOUT a `tokenExp` are
 * allowed — they can only be pre-enforcement legacy rows (the connections
 * table TTL clears them within an hour of the cutover deploy) because
 * `$connect` always stamps `tokenExp` once enforcement is live.
 *
 * @param {number|undefined|null} tokenExp epoch seconds
 * @param {number} [now] epoch milliseconds
 */
const isTokenLive = (tokenExp, now = Date.now()) => {
  if (tokenExp === undefined || tokenExp === null || tokenExp === '') return true;
  const exp = Number(tokenExp);
  if (!Number.isFinite(exp)) return true;
  return exp * 1000 > now;
};

export {
  TOKEN_TTL_SECONDS,
  signRealtimeToken,
  verifyRealtimeToken,
  verifyRealtimeAccess,
  requiredScopeForYjsDoc,
  requiredScopeForChannel,
  isTokenLive,
};
export default {
  TOKEN_TTL_SECONDS,
  signRealtimeToken,
  verifyRealtimeToken,
  verifyRealtimeAccess,
  requiredScopeForYjsDoc,
  requiredScopeForChannel,
  isTokenLive,
};
