import { describe, expect, it } from 'vitest';
import { gatewayPolicyDigest } from '../gateway-grant.js';
import {
  CONTEXT_HEADER,
  CONTEXT_POLICY_HEADER,
  GatewayContextError,
  MAX_CONTEXT_HEADER_BYTES,
  decodeGatewayContext,
  encodeGatewayContext,
  singleHeader,
} from '../mcp/gateway-context.js';
import { scopeFromGrantAndSession } from '../mcp/gateway-session.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const EXPIRES_AT = Math.floor(NOW / 1000) + 600;
const POLICY = { summaryConfirmation: 'required', learnings: 'off' };

const grantFor = (overrides = {}) => ({
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'code-generation',
  unitSlug: 'api',
  sectionIndex: 0,
  policyDigest: gatewayPolicyDigest(POLICY),
  stageCallbackId: 'cb-1',
  orchestratorRunId: 'run-1',
  grantId: 'grant-1',
  keyId: 'kid-1',
  issuedAt: EXPIRES_AT - 900,
  expiresAt: EXPIRES_AT,
  ...overrides,
});
const session = {
  role: 'author',
  stageInstanceId: 'si-1',
  stageAttempt: 0,
  validationRound: 0,
  model: 'm-1',
  reviewerAgent: null,
  agentRef: 'agent-1',
  checkpointOwner: true,
  canAsk: false,
  policy: POLICY,
};

const contextFor = (grant = grantFor(), sessionInput = session) => {
  const context = scopeFromGrantAndSession(grant, sessionInput, { processTable: 'proc' });
  return { grant, context, headers: encodeGatewayContext({ grant, ...context }) };
};
const decode = (headers, now = NOW) =>
  decodeGatewayContext(headers, { processTable: 'proc', now: () => now });
const encodeRaw = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const rawPayload = (headers) =>
  JSON.parse(Buffer.from(headers[CONTEXT_HEADER], 'base64url').toString('utf8'));
const reasonOf = (fn) => {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayContextError);
    return error.reason;
  }
  throw new Error('expected a GatewayContextError');
};

describe('gateway context codec', () => {
  it('round-trips the full scope the handlers consume, zero-valued indices included', () => {
    const { context, headers } = contextFor();
    expect(Object.keys(headers).toSorted()).toEqual(
      [CONTEXT_HEADER, CONTEXT_POLICY_HEADER].toSorted(),
    );
    const decoded = decode(headers);
    expect(decoded.scope).toEqual(context.scope);
    expect(decoded.scope.sectionIndex).toBe(0);
    expect(decoded.scope.stageAttempt).toBe(0);
    expect(decoded.scope.validationRound).toBe(0);
    expect(decoded.scope.policy).toEqual(POLICY);
    expect(decoded.role).toBe('author');
    expect(decoded.mode).toBe('stage');
    expect(decoded.grant).toEqual({ grantId: 'grant-1', expiresAt: EXPIRES_AT });
    expect(Object.isFrozen(decoded.scope)).toBe(true);
  });

  it('keeps runtime assertions apart from granted and verified fields', () => {
    const payload = rawPayload(contextFor().headers);
    expect(payload.v).toBe(1);
    expect(payload.granted).toMatchObject({ grantId: 'grant-1', stageCallbackId: 'cb-1' });
    expect(payload.verified).toEqual({ stageInstanceId: 'si-1' });
    expect(payload.asserted).toMatchObject({ role: 'author', agentRef: 'agent-1', model: 'm-1' });
    expect(payload.asserted).not.toHaveProperty('stageCallbackId');
    expect(payload.granted).not.toHaveProperty('role');
  });

  it('carries the stage owner describe_changes flag through the context', () => {
    const { headers } = contextFor(grantFor(), { ...session, describeChanges: true });
    expect(rawPayload(headers).asserted.describeChanges).toBe(true);
    expect(decode(headers).scope.describeChanges).toBe(true);
    expect(decode(contextFor().headers).scope.describeChanges).toBe(false);
  });

  it('round-trips an intent-level discussion reader without a policy', () => {
    const grant = grantFor({
      mode: 'discussion',
      executionId: 'i-1',
      stageId: null,
      unitSlug: null,
      sectionIndex: null,
      policyDigest: null,
      stageCallbackId: null,
      orchestratorRunId: null,
    });
    const { context, headers } = contextFor(grant, { role: 'reader' });
    expect(decode(headers).scope).toEqual(context.scope);
    expect(decode(headers).mode).toBe('discussion');
  });

  it('reads headers case-insensitively but rejects duplicates and multi-values', () => {
    expect(singleHeader({ 'X-Aidlc-Context': 'a' }, CONTEXT_HEADER)).toBe('a');
    expect(singleHeader({ 'x-aidlc-context': ['a'] }, CONTEXT_HEADER)).toBe('a');
    expect(() =>
      singleHeader({ 'x-aidlc-context': 'a', 'X-Aidlc-Context': 'b' }, CONTEXT_HEADER),
    ).toThrow(GatewayContextError);
    expect(() => singleHeader({ 'x-aidlc-context': ['a', 'b'] }, CONTEXT_HEADER)).toThrow(
      GatewayContextError,
    );
    const { headers } = contextFor();
    expect(reasonOf(() => decode({ ...headers, 'X-AIDLC-CONTEXT': headers[CONTEXT_HEADER] }))).toBe(
      'ambiguous_header',
    );
  });

  it('accepts propagated headers given as a JSON string with mixed-case names', () => {
    const { headers } = contextFor();
    const mixed = JSON.stringify({
      'X-Aidlc-Context': headers[CONTEXT_HEADER],
      'X-Aidlc-Context-Policy': headers[CONTEXT_POLICY_HEADER],
    });
    expect(decode(mixed).scope.stageInstanceId).toBe('si-1');
  });

  it.each([
    ['no headers', () => ({})],
    ['only the context', (h) => ({ [CONTEXT_HEADER]: h[CONTEXT_HEADER] })],
    ['only the policy', (h) => ({ [CONTEXT_POLICY_HEADER]: h[CONTEXT_POLICY_HEADER] })],
  ])('rejects %s as missing', (_label, build) => {
    expect(reasonOf(() => decode(build(contextFor().headers)))).toBe('missing_context');
  });

  it.each([
    ['not base64url', (h) => ({ ...h, [CONTEXT_HEADER]: '{"v":1}' })],
    ['not JSON', (h) => ({ ...h, [CONTEXT_HEADER]: 'bm90LWpzb24' })],
    ['an empty value', (h) => ({ ...h, [CONTEXT_HEADER]: '' })],
    [
      'an oversized value',
      (h) => ({ ...h, [CONTEXT_HEADER]: 'A'.repeat(MAX_CONTEXT_HEADER_BYTES + 1) }),
    ],
    ['another version', (h) => ({ ...h, [CONTEXT_HEADER]: encodeRaw({ ...rawPayload(h), v: 2 }) })],
    [
      'an extra top-level field',
      (h) => ({ ...h, [CONTEXT_HEADER]: encodeRaw({ ...rawPayload(h), extra: true }) }),
    ],
    [
      'an asserted field moved out of its section',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({
            ...p,
            granted: { ...p.granted, role: 'author' },
          }),
        };
      },
    ],
    [
      'a missing granted field',
      (h) => {
        const { stageCallbackId: _dropped, ...granted } = rawPayload(h).granted;
        return { ...h, [CONTEXT_HEADER]: encodeRaw({ ...rawPayload(h), granted }) };
      },
    ],
    [
      'a mistyped index',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({ ...p, granted: { ...p.granted, sectionIndex: '0' } }),
        };
      },
    ],
    [
      'a persona flag that is not a boolean',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({ ...p, asserted: { ...p.asserted, canAsk: 'yes' } }),
        };
      },
    ],
    [
      'an unknown role',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({ ...p, asserted: { ...p.asserted, role: 'admin' } }),
        };
      },
    ],
    [
      'an unknown mode',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({ ...p, granted: { ...p.granted, mode: 'admin' } }),
        };
      },
    ],
    [
      'an engine-data execution grant',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({
            ...p,
            granted: {
              ...p.granted,
              mode: 'execution',
              stageId: null,
              stageCallbackId: null,
              orchestratorRunId: null,
            },
          }),
        };
      },
    ],
    [
      'a policy the digest does not sign',
      (h) => ({ ...h, [CONTEXT_POLICY_HEADER]: encodeRaw({ ...POLICY, learnings: 'on' }) }),
    ],
    ['a dropped policy', (h) => ({ ...h, [CONTEXT_POLICY_HEADER]: encodeRaw(null) })],
    ['a non-object policy', (h) => ({ ...h, [CONTEXT_POLICY_HEADER]: encodeRaw([POLICY]) })],
    [
      'a stage context without a stage instance',
      (h) => {
        const p = rawPayload(h);
        return {
          ...h,
          [CONTEXT_HEADER]: encodeRaw({ ...p, verified: { stageInstanceId: null } }),
        };
      },
    ],
  ])('rejects a context with %s', (_label, build) => {
    expect(reasonOf(() => decode(build(contextFor().headers)))).toBe('context_invalid');
  });

  it('rejects a context whose grant has expired', () => {
    const { headers } = contextFor();
    expect(reasonOf(() => decode(headers, EXPIRES_AT * 1000))).toBe('context_expired');
  });

  it('refuses to encode a policy beyond the header budget', () => {
    const policy = { blob: 'x'.repeat(MAX_CONTEXT_HEADER_BYTES) };
    const grant = grantFor({ policyDigest: gatewayPolicyDigest(policy) });
    const context = scopeFromGrantAndSession(
      grant,
      { ...session, policy },
      { processTable: 'proc' },
    );
    expect(reasonOf(() => encodeGatewayContext({ grant, ...context }))).toBe('context_too_large');
  });
});
