import { describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import {
  gatewayPolicyDigest,
  issueGatewayGrant,
  verifyGatewayGrant,
} from '../../shared/gateway-grant.js';
import { encodeGatewaySession } from '../../shared/mcp/gateway-session.js';
import { createToolGateway, propagatedHeadersFrom, toolNameFrom } from '../tool-gateway.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const KID = 'kid-1';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

const grantFor = (scope) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => NOW + 1000,
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
const lane = { ...stage, stageId: 'code-generation', unitSlug: 'api', sectionIndex: 1 };
const authorSession = {
  role: 'author',
  stageInstanceId: 'si-1',
  stageAttempt: 0,
  checkpointOwner: true,
  canAsk: true,
};
const POLICY = { summaryConfirmation: 'required', learnings: 'off' };

const encodeRaw = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');

const fakeGraphSource = (owned) => {
  const chain = { has: () => chain, hasNext: async () => owned };
  return { V: () => chain };
};

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
  writerOverrides = {},
  createStore = () => ({ getExecution: async () => execution, getStage: async () => row }),
} = {}) => {
  const writer = {
    getArtifact: vi.fn(async ({ id }) => ({ id, title: 'A' })),
    getCoverage: vi.fn(async ({ unitSlug }) => ({ unitSlug })),
    createArtifact: vi.fn(async (input) => ({ id: input.id, artifactType: input.artifactType })),
    ...writerOverrides,
  };
  const audit = vi.fn();
  const order = [];
  let releaseRead;
  const bridge = {
    emitStageNote: vi.fn(),
    rehydrateAuthorizations: vi.fn(async () => {
      order.push('rehydrated');
    }),
    recordGraphRead: vi.fn(
      () =>
        new Promise((resolve) => {
          releaseRead = () => {
            order.push('graph-read-recorded');
            resolve();
          };
          setTimeout(() => releaseRead(), 5);
        }),
    ),
  };
  const createProcessBridge = vi.fn(() => bridge);
  const openGraph = vi.fn(async () => fakeGraphSource(intentOwned));
  const closeGraphSource = vi.fn(async () => {});
  const handler = createToolGateway({
    verifyGrant,
    createStore,
    openGraph,
    closeGraphSource,
    createGraphWriter: () => writer,
    createGraphManager: () => ({ withWriter: (fn) => fn(writer), close: async () => {} }),
    createProcessBridge,
    broadcastToIntent: async () => {},
    processTable: 'proc',
    audit: (record) => {
      order.push(`audit:${record.decision}`);
      audit(record);
    },
  });
  return {
    handler,
    writer,
    audit,
    createProcessBridge,
    bridge,
    openGraph,
    closeGraphSource,
    order,
  };
};

const call = async (handler, { tool, args = {}, grant, session, headerCase = 'lower' }) => {
  const headers = {};
  if (grant !== undefined)
    headers[headerCase === 'lower' ? 'x-aidlc-grant' : 'X-Aidlc-Grant'] = grant;
  if (session !== undefined) headers['x-aidlc-session'] = session;
  return handler(args, {
    clientContext: {
      custom: {
        bedrockAgentCoreToolName: `aidlc___${tool}`,
        bedrockAgentCorePropagatedHeaders: headers,
        bedrockAgentCoreAwsRequestId: 'req-1',
      },
    },
  });
};

const denied = (result) => {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/^Tool call denied/);
};

describe('MCP tools gateway target', () => {
  it('strips the target prefix and normalizes propagated header names', () => {
    expect(toolNameFrom({ bedrockAgentCoreToolName: 'aidlc___get_artifact' })).toBe('get_artifact');
    expect(toolNameFrom({ bedrockAgentCoreToolName: 'aidlc___a___b' })).toBe('a___b');
    expect(
      propagatedHeadersFrom({ bedrockAgentCorePropagatedHeaders: '{"X-Aidlc-Grant":"t"}' }),
    ).toEqual({ 'x-aidlc-grant': 't' });
  });

  it('runs the existing handler with the grant scope, one graph source, and a scoped audit', async () => {
    const { handler, writer, audit, openGraph, closeGraphSource, order } = setup();
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1', projectId: 'p-2', smuggled: true },
      grant: await grantFor(stage),
      session: encodeGatewaySession(authorSession),
      headerCase: 'mixed',
    });
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toEqual({ id: 'a-1', title: 'A' });
    expect(writer.getArtifact).toHaveBeenCalledWith({ id: 'a-1', mode: 'full' });
    expect(openGraph).toHaveBeenCalledTimes(1);
    expect(closeGraphSource).toHaveBeenCalledTimes(1);
    expect(order).toEqual(['rehydrated', 'graph-read-recorded', 'audit:allow']);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'allow',
        outcome: 'ok',
        tool: 'get_artifact',
        role: 'author',
        projectId: 'p-1',
        executionId: 'e-1',
        stageInstanceId: 'si-1',
        grantId: 'grant-1',
      }),
    );
  });

  it.each([
    ['no grant', async () => ({ session: encodeGatewaySession(authorSession) }), 'missing_grant'],
    ['no session', async () => ({ grant: await grantFor(stage) }), 'missing_session'],
    [
      'forged grant',
      async () => ({ grant: 'a.b.c', session: encodeGatewaySession(authorSession) }),
      'grant_invalid',
    ],
    [
      'session naming another space',
      async () => ({
        grant: await grantFor(stage),
        session: encodeRaw({ ...authorSession, projectId: 'p-2' }),
      }),
      'session_outside_grant',
    ],
    [
      'session presenting a policy the grant did not sign',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession({ ...authorSession, policy: POLICY }),
      }),
      'session_outside_grant',
    ],
    [
      'reviewer calling a write tool',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession({ ...authorSession, role: 'reviewer' }),
        tool: 'create_artifact',
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'learning tool withdrawn by the signed policy',
      async () => ({
        grant: await grantFor({ ...stage, policyDigest: gatewayPolicyDigest(POLICY) }),
        session: encodeGatewaySession({ ...authorSession, policy: POLICY }),
        tool: 'record_learning_rule',
        args: { id: 'r', content: 'x' },
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'checkpoint tool for a session that omits ownership',
      async () => ({
        grant: await grantFor({ ...stage, policyDigest: gatewayPolicyDigest(POLICY) }),
        session: encodeRaw({ role: 'author', stageInstanceId: 'si-1', policy: POLICY }),
        tool: 'confirm_summary',
        args: { summary: 's' },
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'question from a session that omits canAsk',
      async () => ({
        grant: await grantFor(stage),
        session: encodeRaw({ role: 'author', stageInstanceId: 'si-1', checkpointOwner: true }),
        tool: 'ask_question',
        args: { questions: [] },
      }),
      'tool_not_allowed_for_role',
    ],
    [
      'arguments outside the tool schema',
      async () => ({
        grant: await grantFor(stage),
        session: encodeGatewaySession(authorSession),
        args: { id: 'a-1', mode: 'everything' },
      }),
      'invalid_arguments',
    ],
  ])('denies %s before any data access', async (_label, build, reason) => {
    const { handler, writer, audit, createProcessBridge } = setup();
    const { tool = 'get_artifact', args = { id: 'a-1' }, ...headers } = await build();
    denied(await call(handler, { tool, args, ...headers }));
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason }));
    expect(writer.getArtifact).not.toHaveBeenCalled();
    expect(writer.createArtifact).not.toHaveBeenCalled();
    expect(createProcessBridge).not.toHaveBeenCalled();
  });

  it('denies an execution-scoped engine grant before any handler or store access', async () => {
    const createStore = vi.fn();
    const { handler, writer, audit, createProcessBridge, openGraph } = setup({ createStore });
    const grant = await grantFor({
      mode: 'execution',
      projectId: 'p-1',
      intentId: 'i-1',
      executionId: 'e-1',
    });
    denied(
      await call(handler, {
        tool: 'get_artifact',
        args: { id: 'a-1' },
        grant,
        session: encodeGatewaySession(authorSession),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        reason: 'grant_mode_not_allowed',
        mode: 'execution',
        executionId: 'e-1',
        grantId: 'grant-1',
      }),
    );
    expect(createStore).not.toHaveBeenCalled();
    expect(openGraph).not.toHaveBeenCalled();
    expect(createProcessBridge).not.toHaveBeenCalled();
    expect(writer.getArtifact).not.toHaveBeenCalled();
  });

  it('allows the checkpoint tool the signed policy adds for the owning session', async () => {
    const { handler, audit } = setup();
    await call(handler, {
      tool: 'confirm_summary',
      args: { summary: 's' },
      grant: await grantFor({ ...stage, policyDigest: gatewayPolicyDigest(POLICY) }),
      session: encodeGatewaySession({ ...authorSession, policy: POLICY }),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', tool: 'confirm_summary' }),
    );
  });

  it('records the verified scope on denials after the grant is accepted', async () => {
    const { handler, audit } = setup();
    await call(handler, {
      tool: 'create_artifact',
      args: { artifactType: 'x', id: 'a' },
      grant: await grantFor(stage),
      session: encodeGatewaySession({ ...authorSession, role: 'reader' }),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        decision: 'deny',
        reason: 'tool_not_allowed_for_role',
        grantId: 'grant-1',
        projectId: 'p-1',
        executionId: 'e-1',
        role: 'reader',
      }),
    );
  });

  it('pins a lane session to its own unit for get_coverage', async () => {
    const { handler, writer, audit } = setup({
      row: stageRow({ stageId: 'code-generation', unitSlug: 'api', sectionIndex: 1 }),
    });
    const grant = await grantFor(lane);
    const session = encodeGatewaySession(authorSession);
    denied(
      await call(handler, { tool: 'get_coverage', args: { unitSlug: 'web' }, grant, session }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'lane_outside_grant' }),
    );
    await call(handler, { tool: 'get_coverage', args: { unitSlug: 'api' }, grant, session });
    expect(writer.getCoverage).toHaveBeenCalledWith({ unitSlug: 'api' });
  });

  it.each([
    ['a parked stage', { row: stageRow({ state: 'WAITING_FOR_HUMAN' }) }],
    [
      'a parked execution',
      { execution: { executionId: 'e-1', projectId: 'p-1', intentId: 'i-1', status: 'WAITING' } },
    ],
  ])('keeps serving %s', async (_label, overrides) => {
    const { handler, writer } = setup(overrides);
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor(stage),
      session: encodeGatewaySession(authorSession),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
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
  ])('revokes calls for %s', async (_label, { grantScope, sessionLeg, ...overrides }) => {
    const { handler, writer, audit } = setup(overrides);
    const oldLeg = { stageCallbackId: 'cb-old', orchestratorRunId: 'run-old' };
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor(grantScope ?? { ...stage, ...oldLeg }),
      session: encodeGatewaySession({ ...authorSession, ...(sessionLeg ?? oldLeg) }),
    });
    denied(result);
    expect(result.content[0].text).toMatch(/no longer active/);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'scope_not_active', projectId: 'p-1' }),
    );
    expect(writer.getArtifact).not.toHaveBeenCalled();
  });

  it('binds a persona session that names no leg to the leg signed in its grant', async () => {
    const { handler, writer } = setup({
      row: stageRow({ stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' }),
    });
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor({ ...stage, stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' }),
      session: encodeGatewaySession({ ...authorSession, role: 'reviewer', reviewerAgent: 'r-1' }),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
  });

  it('rejects a session that rewrites its signed stage leg', async () => {
    const { handler, writer, audit } = setup({
      row: stageRow({ stageCallbackId: 'cb-new', orchestratorRunId: 'run-1' }),
    });
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor({ ...stage, stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' }),
      session: encodeGatewaySession({ ...authorSession, stageCallbackId: 'cb-new' }),
    });
    denied(result);
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' }));
    expect(writer.getArtifact).not.toHaveBeenCalled();
  });

  it('audits a tool error with its scope, keeping the local error contract', async () => {
    const { handler, audit } = setup({
      writerOverrides: {
        getArtifact: vi.fn(async () => {
          throw new Error('artifact not found');
        }),
      },
    });
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor(stage),
      session: encodeGatewaySession(authorSession),
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'artifact not found' }],
      isError: true,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', outcome: 'tool_error', projectId: 'p-1' }),
    );
  });

  it('audits and masks an unexpected failure after authorization', async () => {
    const { handler, audit, bridge, closeGraphSource } = setup();
    bridge.rehydrateAuthorizations.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.3.7:443'),
    );
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor(stage),
      session: encodeGatewaySession(authorSession),
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Tool call failed.' }],
      isError: true,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', outcome: 'handler_error', projectId: 'p-1' }),
    );
    expect(closeGraphSource).toHaveBeenCalledTimes(1);
  });

  it('serves an intent-level discussion reader without a process store', async () => {
    const { handler, writer, createProcessBridge } = setup();
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor({
        mode: 'discussion',
        projectId: 'p-1',
        intentId: 'i-1',
        executionId: 'i-1',
      }),
      session: encodeGatewaySession({ role: 'reader' }),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
    expect(createProcessBridge).not.toHaveBeenCalled();
  });

  it('serves a conflict-resolution reviewer bound to its lane', async () => {
    const { handler, writer } = setup();
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      grant: await grantFor({
        mode: 'conflict',
        projectId: 'p-1',
        intentId: 'i-1',
        executionId: 'e-1',
        unitSlug: 'api',
        sectionIndex: 1,
      }),
      session: encodeGatewaySession({ role: 'reviewer' }),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
  });
});
