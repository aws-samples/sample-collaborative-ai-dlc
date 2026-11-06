import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { gatewayPolicyDigest, issueGatewayGrant, verifyGatewayGrant } from '../gateway-grant.js';
import { encodeGatewaySession } from '../mcp/gateway-session.js';
import {
  GatewayAccessDenied,
  createGatewayAuthorizer,
  splitQualifiedToolName,
  toolAllowedForContext,
} from '../mcp/gateway-authorization.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const grantFor = (scope, { ttlSeconds } = {}) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
    ...(ttlSeconds ? { ttlSeconds } : {}),
  });
const verifyAt =
  (at = NOW + 1000) =>
  (token) =>
    verifyGatewayGrant(token, {
      publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
      now: () => at,
    });

const stage = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  unitSlug: null,
  sectionIndex: null,
};
const lane = { ...stage, stageId: 'code-generation', unitSlug: 'api', sectionIndex: 0 };
const authorSession = {
  role: 'author',
  stageInstanceId: 'si-1',
  stageAttempt: 0,
  checkpointOwner: true,
  canAsk: true,
};
const POLICY = { summaryConfirmation: 'required', learnings: 'off' };
const encodeRaw = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const stageRow = (overrides = {}) => ({
  executionId: 'e-1',
  stageInstanceId: 'si-1',
  stageId: 'requirements-analysis',
  unitSlug: null,
  sectionIndex: null,
  state: 'RUNNING',
  ...overrides,
});

const setup = ({
  execution = { executionId: 'e-1', projectId: 'p-1', intentId: 'i-1', status: 'RUNNING' },
  row = stageRow(),
  intentOwned = true,
  getExecution,
  verifyGrant = verifyAt(),
} = {}) => {
  const store = {
    getExecution: vi.fn(getExecution ?? (async () => execution)),
    getStage: vi.fn(async () => row),
  };
  const createStore = vi.fn(() => store);
  const chain = { has: () => chain, hasNext: async () => intentOwned };
  const openGraph = vi.fn(async () => ({ V: () => chain }));
  const closeGraphSource = vi.fn(async () => {});
  const authorizer = createGatewayAuthorizer({
    verifyGrant,
    createStore,
    openGraph,
    closeGraphSource,
    processTable: 'proc',
  });
  return { authorizer, store, createStore, openGraph, closeGraphSource };
};

const headersFor = async ({ grant, session }) => ({
  ...(grant === undefined ? {} : { 'x-aidlc-grant': grant }),
  ...(session === undefined ? {} : { 'x-aidlc-session': session }),
});

const deniedWith = async (promise) => {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(GatewayAccessDenied);
    return error;
  }
  throw new Error('expected a denial');
};

describe('gateway authorization', () => {
  it('splits a qualified tool name at the first separator only', () => {
    expect(splitQualifiedToolName('aidlc___get_artifact')).toEqual({
      target: 'aidlc',
      tool: 'get_artifact',
    });
    expect(splitQualifiedToolName('aidlc___a___b')).toEqual({ target: 'aidlc', tool: 'a___b' });
    expect(splitQualifiedToolName('get_artifact')).toEqual({ target: null, tool: 'get_artifact' });
    expect(splitQualifiedToolName(undefined)).toEqual({ target: null, tool: null });
  });

  it('returns the grant-bound scope and audit for an allowed tool call', async () => {
    const { authorizer, store } = setup();
    const result = await authorizer.authorize(
      await headersFor({
        grant: await grantFor(stage),
        session: encodeGatewaySession(authorSession),
      }),
      { qualifiedTool: 'aidlc___get_artifact' },
    );
    expect(result.grant.grantId).toBe('grant-1');
    expect(result.role).toBe('author');
    expect(result.scope).toMatchObject({ projectId: 'p-1', stageInstanceId: 'si-1' });
    expect(result.auditScope).toMatchObject({ grantId: 'grant-1', executionId: 'e-1' });
    expect(store.getExecution).toHaveBeenCalledWith('e-1', { consistentRead: true });
    expect(store.getStage).toHaveBeenCalledWith('e-1', 'si-1', { consistentRead: true });
  });

  it('reads the grant and session headers case-insensitively', async () => {
    const { authorizer } = setup();
    const result = await authorizer.authorize(
      {
        'X-Aidlc-Grant': await grantFor(stage),
        'X-AIDLC-SESSION': encodeGatewaySession(authorSession),
      },
      { qualifiedTool: 'aidlc___get_artifact' },
    );
    expect(result.role).toBe('author');
  });

  it.each([
    ['no grant', async () => ({ session: encodeGatewaySession(authorSession) }), 'missing_grant'],
    ['no session', async () => ({ grant: await grantFor(stage) }), 'missing_session'],
    [
      'a forged grant',
      async () => ({ grant: 'a.b.c', session: encodeGatewaySession(authorSession) }),
      'grant_invalid',
    ],
    [
      'a grant signed by another key',
      async () => {
        const other = generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey;
        return {
          grant: await issueGatewayGrant(stage, {
            keyId: KID,
            sign: async (m) => cryptoSign('sha256', m, other),
            now: () => NOW,
          }),
          session: encodeGatewaySession(authorSession),
        };
      },
      'grant_invalid',
    ],
    [
      'a session naming another space',
      async () => ({
        grant: await grantFor(stage),
        session: encodeRaw({ ...authorSession, projectId: 'p-2' }),
      }),
      'session_outside_grant',
    ],
    [
      'a session presenting a policy the grant did not sign',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession({ ...authorSession, policy: POLICY }),
      }),
      'session_outside_grant',
    ],
    [
      'a session forging an unknown persona role',
      async () => ({
        grant: await grantFor(stage),
        session: encodeRaw({ ...authorSession, role: 'admin' }),
      }),
      'session_outside_grant',
    ],
    [
      'a session that rewrites its signed stage leg',
      async () => ({
        grant: await grantFor({ ...stage, stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' }),
        session: encodeGatewaySession({ ...authorSession, stageCallbackId: 'cb-new' }),
      }),
      'session_outside_grant',
    ],
    [
      'a reviewer calling a write tool',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession({ ...authorSession, role: 'reviewer' }),
        tool: 'aidlc___create_artifact',
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'a learning tool withdrawn by the signed policy',
      async () => ({
        grant: await grantFor({ ...stage, policyDigest: gatewayPolicyDigest(POLICY) }),
        session: encodeGatewaySession({ ...authorSession, policy: POLICY }),
        tool: 'aidlc___record_learning_rule',
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'a checkpoint tool for a session that omits ownership',
      async () => ({
        grant: await grantFor({ ...stage, policyDigest: gatewayPolicyDigest(POLICY) }),
        session: encodeRaw({ role: 'author', stageInstanceId: 'si-1', policy: POLICY }),
        tool: 'aidlc___confirm_summary',
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'a question from a session that omits canAsk',
      async () => ({
        grant: await grantFor(stage),
        session: encodeRaw({ role: 'author', stageInstanceId: 'si-1', checkpointOwner: true }),
        tool: 'aidlc___ask_question',
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'an unknown tool',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession(authorSession),
        tool: 'aidlc___drop_database',
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'an unknown target',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession(authorSession),
        tool: 'other___get_artifact',
      }),
      'unknown_target',
    ],
    [
      'an unqualified tool name',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession(authorSession),
        tool: 'get_artifact',
      }),
      'unknown_target',
    ],
  ])('denies %s before any data access', async (_label, build, reason) => {
    const { authorizer, createStore, openGraph } = setup();
    const { tool = 'aidlc___get_artifact', ...input } = await build();
    const error = await deniedWith(
      authorizer.authorize(await headersFor(input), { qualifiedTool: tool }),
    );
    expect(error.reason).toBe(reason);
    expect(createStore).not.toHaveBeenCalled();
    expect(openGraph).not.toHaveBeenCalled();
  });

  it('denies an expired grant', async () => {
    const { authorizer } = setup({ verifyGrant: verifyAt(NOW + 2 * 60 * 60 * 1000) });
    const error = await deniedWith(
      authorizer.authorize(
        await headersFor({
          grant: await grantFor(stage, { ttlSeconds: 60 }),
          session: encodeGatewaySession(authorSession),
        }),
      ),
    );
    expect(error.reason).toBe('grant_expired');
  });

  it('rejects duplicated grant headers instead of picking one', async () => {
    const { authorizer } = setup();
    const grant = await grantFor(stage);
    const error = await deniedWith(
      authorizer.authorize({
        'x-aidlc-grant': grant,
        'X-Aidlc-Grant': grant,
        'x-aidlc-session': encodeGatewaySession(authorSession),
      }),
    );
    expect(error.reason).toBe('ambiguous_header');
  });

  it('rejects a grant whose mode the built-in MCP does not serve', async () => {
    const { authorizer } = setup({
      verifyGrant: async () => ({ ...stage, mode: 'admin', grantId: 'g' }),
    });
    const error = await deniedWith(
      authorizer.authorize(
        await headersFor({ grant: 'x', session: encodeGatewaySession(authorSession) }),
      ),
    );
    expect(error.reason).toBe('mode_not_allowed');
  });

  it('records the verified scope on denials after the grant is accepted', async () => {
    const { authorizer } = setup();
    const error = await deniedWith(
      authorizer.authorize(
        await headersFor({
          grant: await grantFor(stage),
          session: encodeGatewaySession({ ...authorSession, role: 'reader' }),
        }),
        { qualifiedTool: 'aidlc___create_artifact' },
      ),
    );
    expect(error.auditScope).toMatchObject({
      grantId: 'grant-1',
      projectId: 'p-1',
      executionId: 'e-1',
      role: 'reader',
    });
  });

  it('allows the checkpoint tool the signed policy adds for the owning session', async () => {
    const { authorizer } = setup();
    const result = await authorizer.authorize(
      await headersFor({
        grant: await grantFor({ ...stage, policyDigest: gatewayPolicyDigest(POLICY) }),
        session: encodeGatewaySession({ ...authorSession, policy: POLICY }),
      }),
      { qualifiedTool: 'aidlc___confirm_summary' },
    );
    expect(result.scope.policy).toEqual(POLICY);
  });

  it.each([
    ['a parked stage', { row: stageRow({ state: 'WAITING_FOR_HUMAN' }) }],
    [
      'a parked execution',
      { execution: { executionId: 'e-1', projectId: 'p-1', intentId: 'i-1', status: 'WAITING' } },
    ],
  ])('keeps authorizing %s', async (_label, overrides) => {
    const { authorizer } = setup(overrides);
    await expect(
      authorizer.authorize(
        await headersFor({
          grant: await grantFor(stage),
          session: encodeGatewaySession(authorSession),
        }),
        { qualifiedTool: 'aidlc___get_artifact' },
      ),
    ).resolves.toMatchObject({ role: 'author' });
  });

  it.each([
    [
      'a finished execution',
      { execution: { executionId: 'e-1', projectId: 'p-1', intentId: 'i-1', status: 'SUCCEEDED' } },
    ],
    [
      'an execution of another space',
      { execution: { executionId: 'e-1', projectId: 'p-2', intentId: 'i-1', status: 'RUNNING' } },
    ],
    ['a finished stage', { row: stageRow({ state: 'SUCCEEDED' }) }],
    ['a superseded stage leg', { row: stageRow({ stageCallbackId: 'cb-new' }) }],
    ['a superseded orchestrator run', { row: stageRow({ orchestratorRunId: 'run-new' }) }],
    [
      'a run retired on the execution while its stage row still names it',
      {
        execution: {
          executionId: 'e-1',
          projectId: 'p-1',
          intentId: 'i-1',
          status: 'WAITING',
          orchestratorRunId: 'retired-1',
        },
        row: stageRow({ stageCallbackId: 'cb-old', orchestratorRunId: 'run-old' }),
      },
    ],
    [
      'a session that names no leg',
      { row: stageRow({ stageCallbackId: 'cb-new' }), grantScope: stage, sessionLeg: {} },
    ],
    ['an intent not owned by the space', { intentOwned: false }],
    [
      'a failed live read',
      {
        getExecution: async () => {
          throw Object.assign(new Error('denied'), { name: 'AccessDeniedException' });
        },
      },
    ],
  ])('revokes %s', async (_label, { grantScope, sessionLeg, ...overrides }) => {
    const { authorizer } = setup(overrides);
    const oldLeg = { stageCallbackId: 'cb-old', orchestratorRunId: 'run-old' };
    const error = await deniedWith(
      authorizer.authorize(
        await headersFor({
          grant: await grantFor(grantScope ?? { ...stage, ...oldLeg }),
          session: encodeGatewaySession({ ...authorSession, ...(sessionLeg ?? oldLeg) }),
        }),
        { qualifiedTool: 'aidlc___get_artifact' },
      ),
    );
    expect(error.reason).toBe('scope_not_active');
    expect(error.auditScope).toMatchObject({ projectId: 'p-1' });
  });

  it('binds a persona session that names no leg to the leg signed in its grant', async () => {
    const { authorizer } = setup({
      row: stageRow({ stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' }),
    });
    const result = await authorizer.authorize(
      await headersFor({
        grant: await grantFor({ ...stage, stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' }),
        session: encodeGatewaySession({ ...authorSession, role: 'reviewer', reviewerAgent: 'r-1' }),
      }),
      { qualifiedTool: 'aidlc___get_artifact' },
    );
    expect(result.scope).toMatchObject({ stageCallbackId: 'cb-1', reviewerAgent: 'r-1' });
  });

  it('authorizes a session-level method with the same live checks', async () => {
    const { authorizer, store, openGraph } = setup({
      row: stageRow({ stageId: 'code-generation', unitSlug: 'api', sectionIndex: 0 }),
    });
    const result = await authorizer.authorize(
      await headersFor({
        grant: await grantFor(lane),
        session: encodeGatewaySession(authorSession),
      }),
    );
    expect(result.scope).toMatchObject({ unitSlug: 'api', sectionIndex: 0 });
    expect(store.getStage).toHaveBeenCalled();
    expect(openGraph).toHaveBeenCalled();
  });

  it('serves an intent-level discussion reader without a process store', async () => {
    const { authorizer, createStore, openGraph } = setup();
    const result = await authorizer.authorize(
      await headersFor({
        grant: await grantFor({
          mode: 'discussion',
          projectId: 'p-1',
          intentId: 'i-1',
          executionId: 'i-1',
        }),
        session: encodeGatewaySession({ role: 'reader' }),
      }),
      { qualifiedTool: 'aidlc___get_artifact' },
    );
    expect(result.mode).toBe('discussion');
    expect(createStore).not.toHaveBeenCalled();
    expect(openGraph).toHaveBeenCalled();
  });

  it('serves a conflict-resolution reviewer bound to its lane', async () => {
    const { authorizer } = setup();
    const result = await authorizer.authorize(
      await headersFor({
        grant: await grantFor({
          mode: 'conflict',
          projectId: 'p-1',
          intentId: 'i-1',
          executionId: 'e-1',
          unitSlug: 'api',
          sectionIndex: 1,
        }),
        session: encodeGatewaySession({ role: 'reviewer' }),
      }),
      { qualifiedTool: 'aidlc___get_artifact' },
    );
    expect(result).toMatchObject({ mode: 'conflict', role: 'reviewer' });
  });

  it('uses one predicate for role, target and tool', () => {
    const context = {
      role: 'reviewer',
      scope: {
        stageId: 'requirements-analysis',
        policy: null,
        checkpointOwner: false,
        canAsk: false,
      },
    };
    expect(toolAllowedForContext(context, 'aidlc', 'get_artifact')).toBe(true);
    expect(toolAllowedForContext(context, 'aidlc', 'create_artifact')).toBe(false);
    expect(toolAllowedForContext(context, 'other', 'get_artifact')).toBe(false);
  });
});
