// The trusted context the Gateway REQUEST interceptor injects for the built-in
// `aidlc` target, once it has verified the caller's grant, session and live
// scope. The tools Lambda acts on this context instead of re-verifying them.
//
// It is only trustworthy because (a) the interceptor sets BOTH headers on every
// request it allows, so a caller-supplied value never survives, and (b) only
// the Gateway role can invoke the tools Lambda. The decoder still validates it
// strictly (version, exact fields, types, size, policy digest) so a malformed or
// partial context fails closed instead of widening a session.
//
// Sections keep provenance explicit:
//   granted  — signed in the control-plane grant;
//   verified — named by the session, confirmed against the live stage row;
//   asserted — the runtime's choice of sub-role and persona inside the grant
//              (role, persona, attempt metadata, model). Never widens beyond
//              the grant: the stage, lane and leg it acts in are all granted.
// The resolved release policy travels in its own header, bound to the signed
// digest, so the context stays far below the Gateway's per-header limit.
import { MCP_GRANT_MODES, gatewayPolicyDigest, normalizeGatewayScope } from '../gateway-grant.js';
import { scopeFromGrantAndSession } from './gateway-session.js';

export const CONTEXT_HEADER = 'x-aidlc-context';
export const CONTEXT_POLICY_HEADER = 'x-aidlc-context-policy';
export const CONTEXT_HEADERS = Object.freeze([CONTEXT_HEADER, CONTEXT_POLICY_HEADER]);
export const CONTEXT_VERSION = 1;
// Gateway header values are limited to 4 KB.
export const MAX_CONTEXT_HEADER_BYTES = 4096;

const GRANTED_FIELDS = Object.freeze([
  'grantId',
  'expiresAt',
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
const VERIFIED_FIELDS = Object.freeze(['stageInstanceId']);
const ASSERTED_FIELDS = Object.freeze([
  'role',
  'stageAttempt',
  'validationRound',
  'model',
  'reviewerAgent',
  'agentRef',
  'checkpointOwner',
  'canAsk',
  'describeChanges',
]);
const TOP_FIELDS = Object.freeze(['v', 'granted', 'verified', 'asserted']);

export class GatewayContextError extends Error {
  constructor(reason) {
    super('Gateway context is not acceptable');
    this.name = 'GatewayContextError';
    this.reason = reason;
  }
}

const invalid = () => new GatewayContextError('context_invalid');

const isPlainObject = (value) =>
  Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// Header maps arrive as an object (Gateway interceptor input, Lambda target
// client context) or, defensively, a JSON string.
export const headerMapFrom = (raw) => {
  let headers = raw;
  if (typeof raw === 'string') {
    try {
      headers = JSON.parse(raw);
    } catch {
      return {};
    }
  }
  return isPlainObject(headers) ? headers : {};
};

// Header names are case-insensitive. A header that appears more than once —
// under two spellings or as a multi-value list — is ambiguous and rejected,
// never resolved by picking one.
export const singleHeader = (headers, name) => {
  const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
  if (matches.length === 0) return undefined;
  if (matches.length > 1) throw new GatewayContextError('ambiguous_header');
  let [, value] = matches[0];
  if (Array.isArray(value)) {
    if (value.length !== 1) throw new GatewayContextError('ambiguous_header');
    [value] = value;
  }
  if (typeof value !== 'string') throw new GatewayContextError('ambiguous_header');
  return value;
};

const encodeJson = (value) => {
  const encoded = Buffer.from(JSON.stringify(value)).toString('base64url');
  if (Buffer.byteLength(encoded) > MAX_CONTEXT_HEADER_BYTES) {
    throw new GatewayContextError('context_too_large');
  }
  return encoded;
};

const decodeJson = (encoded) => {
  if (
    typeof encoded !== 'string' ||
    !encoded ||
    Buffer.byteLength(encoded) > MAX_CONTEXT_HEADER_BYTES ||
    !/^[A-Za-z0-9_-]+$/.test(encoded)
  ) {
    throw invalid();
  }
  try {
    return JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    throw invalid();
  }
};

const pick = (source, fields) =>
  Object.fromEntries(fields.map((key) => [key, source[key] ?? null]));

const exactKeys = (value, fields) =>
  isPlainObject(value) &&
  Object.keys(value).length === fields.length &&
  fields.every((key) => Object.hasOwn(value, key));

const optionalString = (value) => value === null || (typeof value === 'string' && value !== '');
const count = (value) => Number.isInteger(value) && value >= 0;

// `grant` is a verified grant (verifyGatewayGrant); `scope` and `role` are what
// the authorizer derived from it and the session (scopeFromGrantAndSession).
// Returns the header map the interceptor injects — and nothing else.
export const encodeGatewayContext = ({ grant, scope, role }) => {
  const payload = {
    v: CONTEXT_VERSION,
    granted: pick(grant, GRANTED_FIELDS),
    verified: pick(scope, VERIFIED_FIELDS),
    asserted: { ...pick(scope, ASSERTED_FIELDS), role },
  };
  return {
    [CONTEXT_HEADER]: encodeJson(payload),
    [CONTEXT_POLICY_HEADER]: encodeJson(scope.policy ?? null),
  };
};

const validatePayload = (payload) => {
  if (!exactKeys(payload, TOP_FIELDS) || payload.v !== CONTEXT_VERSION) throw invalid();
  const { granted, verified, asserted } = payload;
  if (!exactKeys(granted, GRANTED_FIELDS)) throw invalid();
  if (!exactKeys(verified, VERIFIED_FIELDS)) throw invalid();
  if (!exactKeys(asserted, ASSERTED_FIELDS)) throw invalid();
  if (typeof granted.grantId !== 'string' || !granted.grantId) throw invalid();
  if (!Number.isInteger(granted.expiresAt) || granted.expiresAt <= 0) throw invalid();
  if (!MCP_GRANT_MODES.includes(granted.mode)) throw invalid();
  try {
    normalizeGatewayScope(granted);
  } catch {
    throw invalid();
  }
  if (!optionalString(verified.stageInstanceId)) throw invalid();
  if (
    typeof asserted.role !== 'string' ||
    !count(asserted.stageAttempt) ||
    !count(asserted.validationRound) ||
    !optionalString(asserted.model) ||
    !optionalString(asserted.reviewerAgent) ||
    !optionalString(asserted.agentRef) ||
    typeof asserted.checkpointOwner !== 'boolean' ||
    typeof asserted.canAsk !== 'boolean' ||
    typeof asserted.describeChanges !== 'boolean'
  ) {
    throw invalid();
  }
};

// Decode and validate the injected context from the Lambda target's propagated
// headers. Returns the same `{ scope, role, mode }` the local MCP server builds
// from its env, plus the grant identity for audit.
export const decodeGatewayContext = (rawHeaders, { processTable, now = Date.now }) => {
  const headers = headerMapFrom(rawHeaders);
  const encoded = singleHeader(headers, CONTEXT_HEADER);
  const encodedPolicy = singleHeader(headers, CONTEXT_POLICY_HEADER);
  if (encoded === undefined || encodedPolicy === undefined) {
    throw new GatewayContextError('missing_context');
  }
  const payload = decodeJson(encoded);
  validatePayload(payload);
  const policy = decodeJson(encodedPolicy);
  if (policy !== null && !isPlainObject(policy)) throw invalid();
  const { granted, verified, asserted } = payload;
  if (gatewayPolicyDigest(policy) !== granted.policyDigest) throw invalid();
  if (granted.expiresAt <= Math.floor(now() / 1000)) {
    throw new GatewayContextError('context_expired');
  }
  let context;
  try {
    // The same parser the interceptor ran: identical role/mode/scope rules and
    // the same frozen scope shape the handlers consume.
    context = scopeFromGrantAndSession(
      granted,
      { ...asserted, ...verified, policy },
      { processTable },
    );
  } catch {
    throw invalid();
  }
  return {
    ...context,
    grant: { grantId: granted.grantId, expiresAt: granted.expiresAt },
  };
};
