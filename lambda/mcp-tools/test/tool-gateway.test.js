import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { gatewayPolicyDigest } from '../../shared/gateway-grant.js';
import { scopeFromGrantAndSession } from '../../shared/mcp/gateway-session.js';
import {
  CONTEXT_HEADER,
  CONTEXT_POLICY_HEADER,
  encodeGatewayContext,
} from '../../shared/mcp/gateway-context.js';
import { createProcessBridge as createRealProcessBridge } from '../../shared/mcp/process-bridge.js';
import { createProcessStore } from '../../shared/v2-process-store.js';
import { executionMetaKey } from '../../shared/v2-process-keys.js';
import { createV2Table, deleteV2Table, makeDdb } from '../../agentcore/test/helpers/v2-table.js';
import { createToolGateway, toolNameFrom } from '../tool-gateway.js';

const NOW = Date.parse('2026-10-16T12:00:00.000Z');
const EXPIRES_AT = Math.floor(NOW / 1000) + 600;

// The interceptor's verified grant: the target never sees the signed token.
const grantOf = (scope) => ({
  stageId: null,
  unitSlug: null,
  sectionIndex: null,
  policyDigest: null,
  stageCallbackId: null,
  orchestratorRunId: null,
  grantId: 'grant-1',
  expiresAt: EXPIRES_AT,
  ...scope,
});
const stage = {
  mode: 'stage',
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
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

const contextHeaders = (scope, session) => {
  const grant = grantOf(scope);
  const context = scopeFromGrantAndSession(grant, session, { processTable: 'proc' });
  return encodeGatewayContext({ grant, ...context });
};
const encodeRaw = (value) => Buffer.from(JSON.stringify(value)).toString('base64url');
const withPayload = (headers, edit) => ({
  ...headers,
  [CONTEXT_HEADER]: encodeRaw(
    edit(JSON.parse(Buffer.from(headers[CONTEXT_HEADER], 'base64url').toString('utf8'))),
  ),
});

const setup = ({ writerOverrides = {}, now = () => NOW } = {}) => {
  const writer = {
    getArtifact: vi.fn(async ({ id }) => ({ id, title: 'A' })),
    getCoverage: vi.fn(async ({ unitSlug }) => ({ unitSlug })),
    createArtifact: vi.fn(async (input) => ({ id: input.id, artifactType: input.artifactType })),
    ...writerOverrides,
  };
  const audit = vi.fn();
  const order = [];
  const bridge = {
    emitStageNote: vi.fn(),
    rehydrateAuthorizations: vi.fn(async () => {
      order.push('rehydrated');
    }),
    recordGraphRead: vi.fn(
      () =>
        new Promise((resolve) => {
          setTimeout(() => {
            order.push('graph-read-recorded');
            resolve();
          }, 5);
        }),
    ),
  };
  const createProcessBridgeFake = vi.fn(() => bridge);
  const createStore = vi.fn(() => ({}));
  const openGraph = vi.fn(async () => ({}));
  const closeGraphSource = vi.fn(async () => {});
  const handler = createToolGateway({
    createStore,
    openGraph,
    closeGraphSource,
    createGraphWriter: () => writer,
    createGraphManager: ({ openGraph: source }) => ({
      withWriter: async (fn) => {
        await source();
        return fn(writer);
      },
      close: async () => {},
    }),
    createProcessBridge: createProcessBridgeFake,
    broadcastToIntent: async () => {},
    processTable: 'proc',
    now,
    audit: (record) => {
      order.push(`audit:${record.decision}`);
      audit(record);
    },
  });
  return {
    handler,
    writer,
    audit,
    createProcessBridge: createProcessBridgeFake,
    createStore,
    bridge,
    openGraph,
    closeGraphSource,
    order,
  };
};

const call = (handler, { tool, args = {}, headers, qualified = `aidlc___${tool}` }) =>
  handler(args, {
    clientContext: {
      custom: {
        bedrockAgentCoreToolName: qualified,
        bedrockAgentCorePropagatedHeaders: headers,
        bedrockAgentCoreAwsRequestId: 'req-1',
      },
    },
  });

const denied = (result) => {
  expect(result.isError).toBe(true);
  expect(result.content[0].text).toMatch(/^Tool call denied/);
};

describe('MCP tools gateway target', () => {
  it('strips the aidlc target prefix and refuses another target', () => {
    expect(toolNameFrom({ bedrockAgentCoreToolName: 'aidlc___get_artifact' })).toBe('get_artifact');
    expect(toolNameFrom({ bedrockAgentCoreToolName: 'aidlc___a___b' })).toBe('a___b');
    expect(toolNameFrom({ bedrockAgentCoreToolName: 'other___get_artifact' })).toBeNull();
  });

  it('runs the existing handler with the injected scope, one graph source, and a scoped audit', async () => {
    const { handler, writer, audit, openGraph, closeGraphSource, order } = setup();
    const headers = contextHeaders(stage, authorSession);
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1', projectId: 'p-2', smuggled: true },
      headers: {
        'X-Aidlc-Context': headers[CONTEXT_HEADER],
        'X-Aidlc-Context-Policy': headers[CONTEXT_POLICY_HEADER],
      },
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

  it('accepts propagated headers given as a JSON string', async () => {
    const { handler, writer } = setup();
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      headers: JSON.stringify(contextHeaders(stage, authorSession)),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
  });

  it('hands the process bridge the full scope it fences writes with', async () => {
    const { handler, createProcessBridge } = setup();
    await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      headers: contextHeaders(
        { ...lane, stageCallbackId: 'cb-1', orchestratorRunId: 'run-1' },
        { ...authorSession, stageAttempt: 2, validationRound: 1, model: 'm-1', agentRef: 'ag' },
      ),
    });
    expect(createProcessBridge).toHaveBeenCalledWith(
      expect.objectContaining({
        scope: expect.objectContaining({
          executionId: 'e-1',
          stageInstanceId: 'si-1',
          unitSlug: 'api',
          sectionIndex: 1,
          stageAttempt: 2,
          validationRound: 1,
          model: 'm-1',
          agentRef: 'ag',
          stageCallbackId: 'cb-1',
          orchestratorRunId: 'run-1',
        }),
      }),
    );
  });

  it.each([
    ['no context', () => ({}), 'missing_context'],
    [
      'only the grant and session headers',
      () => ({ 'x-aidlc-grant': 'a.b.c', 'x-aidlc-session': encodeRaw(authorSession) }),
      'missing_context',
    ],
    [
      'a context without its policy header',
      () => ({ [CONTEXT_HEADER]: contextHeaders(stage, authorSession)[CONTEXT_HEADER] }),
      'missing_context',
    ],
    [
      'a malformed context',
      () => ({ ...contextHeaders(stage, authorSession), [CONTEXT_HEADER]: 'not-json' }),
      'context_invalid',
    ],
    [
      'an oversized context',
      () => ({ ...contextHeaders(stage, authorSession), [CONTEXT_HEADER]: 'A'.repeat(5000) }),
      'context_invalid',
    ],
    [
      'a context duplicated under two spellings',
      () => {
        const headers = contextHeaders(stage, authorSession);
        return { ...headers, 'X-AIDLC-CONTEXT': headers[CONTEXT_HEADER] };
      },
      'ambiguous_header',
    ],
    [
      'a context of another version',
      () => withPayload(contextHeaders(stage, authorSession), (p) => ({ ...p, v: 2 })),
      'context_invalid',
    ],
    [
      'an engine-data execution grant',
      () =>
        withPayload(contextHeaders(stage, authorSession), (p) => ({
          ...p,
          granted: {
            ...p.granted,
            mode: 'execution',
            stageId: null,
            stageCallbackId: null,
            orchestratorRunId: null,
          },
        })),
      'context_invalid',
    ],
    [
      'a forged persona role',
      () =>
        withPayload(contextHeaders(stage, authorSession), (p) => ({
          ...p,
          asserted: { ...p.asserted, role: 'admin' },
        })),
      'context_invalid',
    ],
    [
      'a policy the signed digest does not cover',
      () => ({
        ...contextHeaders(
          { ...stage, policyDigest: gatewayPolicyDigest(POLICY) },
          {
            ...authorSession,
            policy: POLICY,
          },
        ),
        [CONTEXT_POLICY_HEADER]: encodeRaw({ ...POLICY, learnings: 'on' }),
      }),
      'context_invalid',
    ],
    [
      'a reviewer calling a write tool',
      () => contextHeaders(stage, { ...authorSession, role: 'reviewer' }),
      'tool_not_allowed_for_role',
      'create_artifact',
    ],
    [
      'a learning tool withdrawn by the signed policy',
      () =>
        contextHeaders(
          { ...stage, policyDigest: gatewayPolicyDigest(POLICY) },
          {
            ...authorSession,
            policy: POLICY,
          },
        ),
      'tool_not_allowed_for_role',
      'record_learning_rule',
      { id: 'r', content: 'x' },
    ],
    [
      'a checkpoint tool for a session that omits ownership',
      () =>
        contextHeaders(
          { ...stage, policyDigest: gatewayPolicyDigest(POLICY) },
          {
            role: 'author',
            stageInstanceId: 'si-1',
            policy: POLICY,
          },
        ),
      'tool_not_allowed_for_role',
      'confirm_summary',
      { summary: 's' },
    ],
    [
      'a question from a session that omits canAsk',
      () =>
        contextHeaders(stage, { role: 'author', stageInstanceId: 'si-1', checkpointOwner: true }),
      'tool_not_allowed_for_role',
      'ask_question',
      { questions: [] },
    ],
    [
      'arguments outside the tool schema',
      () => contextHeaders(stage, authorSession),
      'invalid_arguments',
      'get_artifact',
      { id: 'a-1', mode: 'everything' },
    ],
  ])('denies %s before any data access', async (_label, headersOf, reason, tool, args) => {
    const { handler, writer, audit, createProcessBridge, createStore, openGraph } = setup();
    denied(
      await call(handler, {
        tool: tool ?? 'get_artifact',
        args: args ?? { id: 'a-1' },
        headers: headersOf(),
      }),
    );
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny', reason }));
    expect(writer.getArtifact).not.toHaveBeenCalled();
    expect(writer.createArtifact).not.toHaveBeenCalled();
    expect(createProcessBridge).not.toHaveBeenCalled();
    expect(createStore).not.toHaveBeenCalled();
    expect(openGraph).not.toHaveBeenCalled();
  });

  it('denies a call for another target', async () => {
    const { handler, audit } = setup();
    denied(
      await call(handler, {
        tool: 'get_artifact',
        qualified: 'other___get_artifact',
        args: { id: 'a-1' },
        headers: contextHeaders(stage, authorSession),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'missing_tool_name' }),
    );
  });

  it('denies a context whose grant has expired since the interceptor saw it', async () => {
    const { handler, audit } = setup({ now: () => EXPIRES_AT * 1000 });
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      headers: contextHeaders(stage, authorSession),
    });
    denied(result);
    expect(result.content[0].text).toMatch(/expired/);
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'grant_expired' }),
    );
  });

  it('allows the checkpoint tool the signed policy adds for the owning session', async () => {
    const { handler, audit } = setup();
    await call(handler, {
      tool: 'confirm_summary',
      args: { summary: 's' },
      headers: contextHeaders(
        { ...stage, policyDigest: gatewayPolicyDigest(POLICY) },
        { ...authorSession, policy: POLICY },
      ),
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', tool: 'confirm_summary' }),
    );
  });

  it('allows describe_changes for the owning session that was offered it', async () => {
    const { handler, audit, bridge } = setup();
    bridge.describeChanges = vi.fn(async (input) => ({ recorded: input }));
    const args = { type: 'fix', scope: 'billing', summary: 'round totals' };
    const result = await call(handler, {
      tool: 'describe_changes',
      args,
      headers: contextHeaders(stage, { ...authorSession, describeChanges: true }),
    });
    expect(result.isError).toBeUndefined();
    expect(bridge.describeChanges).toHaveBeenCalledWith(expect.objectContaining(args));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', tool: 'describe_changes', outcome: 'ok' }),
    );
  });

  it('denies describe_changes for a session that was not offered it', async () => {
    const { handler, audit, createProcessBridge } = setup();
    denied(
      await call(handler, {
        tool: 'describe_changes',
        args: { type: 'fix', summary: 'round totals' },
        headers: contextHeaders(stage, authorSession),
      }),
    );
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'tool_not_allowed_for_role' }),
    );
    expect(createProcessBridge).not.toHaveBeenCalled();
  });

  it('records the injected scope on denials after the context is accepted', async () => {
    const { handler, audit } = setup();
    await call(handler, {
      tool: 'create_artifact',
      args: { artifactType: 'x', id: 'a' },
      headers: contextHeaders(stage, { ...authorSession, role: 'reader' }),
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
    const { handler, writer, audit } = setup();
    const headers = contextHeaders(lane, authorSession);
    denied(await call(handler, { tool: 'get_coverage', args: { unitSlug: 'web' }, headers }));
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'deny', reason: 'lane_outside_grant' }),
    );
    await call(handler, { tool: 'get_coverage', args: { unitSlug: 'api' }, headers });
    expect(writer.getCoverage).toHaveBeenCalledWith({ unitSlug: 'api' });
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
      headers: contextHeaders(stage, authorSession),
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
    const { handler, audit, bridge, openGraph, closeGraphSource } = setup();
    bridge.rehydrateAuthorizations.mockRejectedValueOnce(
      new Error('connect ECONNREFUSED 10.0.3.7:443'),
    );
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      headers: contextHeaders(stage, authorSession),
    });
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Tool call failed.' }],
      isError: true,
    });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({ decision: 'allow', outcome: 'handler_error', projectId: 'p-1' }),
    );
    expect(closeGraphSource).toHaveBeenCalledTimes(openGraph.mock.calls.length);
  });

  it('serves an intent-level discussion reader without a process store', async () => {
    const { handler, writer, createProcessBridge, createStore } = setup();
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      headers: contextHeaders(
        { mode: 'discussion', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' },
        { role: 'reader' },
      ),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
    expect(createProcessBridge).not.toHaveBeenCalled();
    expect(createStore).not.toHaveBeenCalled();
  });

  it('serves a conflict-resolution reviewer bound to its lane', async () => {
    const { handler, writer } = setup();
    const result = await call(handler, {
      tool: 'get_artifact',
      args: { id: 'a-1' },
      headers: contextHeaders(
        {
          mode: 'conflict',
          projectId: 'p-1',
          intentId: 'i-1',
          executionId: 'e-1',
          unitSlug: 'api',
          sectionIndex: 1,
        },
        { role: 'reviewer' },
      ),
    });
    expect(result.isError).toBeUndefined();
    expect(writer.getArtifact).toHaveBeenCalled();
  });
});

// The interceptor's live check is preflight: a rewind that lands after it
// authorized the call must still be rejected by the store's ownership fence.
describe('MCP tools gateway target — store ownership', () => {
  const table = `mcp-tools-${randomUUID()}`;
  let db;

  beforeAll(async () => {
    db = makeDdb();
    await createV2Table(db.client, table);
  });
  afterAll(async () => {
    if (db) {
      await deleteV2Table(db.client, table);
      db.client.destroy();
    }
  });

  it.each([
    ['the leg is still current', false],
    ['the run was rewound after authorization', true],
  ])('fences a question write when %s', async (_label, rewound) => {
    const executionId = `exec-${randomUUID()}`;
    const store = createProcessStore({ ddb: db.doc, tableName: table });
    await store.createExecution({
      executionId,
      intentId: 'i-1',
      projectId: 'p-1',
      status: 'RUNNING',
      orchestratorRunId: 'run-1',
    });
    await store.putStage({
      executionId,
      stageInstanceId: 'si-1',
      stageId: 'requirements-analysis',
      state: 'RUNNING',
      stageCallbackId: 'cb-1',
    });
    await store.updateExecution({
      executionId,
      projectId: 'p-1',
      credentialBinding: { provider: 'bedrock', source: 'user', userId: 'u-1' },
      ownership: { orchestratorRunId: 'run-1', stageCallbackId: 'cb-1', stageInstanceId: 'si-1' },
    });
    const headers = (() => {
      const grant = grantOf({
        ...stage,
        executionId,
        stageCallbackId: 'cb-1',
        orchestratorRunId: 'run-1',
      });
      const context = scopeFromGrantAndSession(grant, authorSession, { processTable: table });
      return encodeGatewayContext({ grant, ...context });
    })();
    if (rewound) {
      await db.doc.send(
        new UpdateCommand({
          TableName: table,
          Key: executionMetaKey(executionId),
          UpdateExpression: 'SET orchestratorRunId = :run',
          ExpressionAttributeValues: { ':run': 'run-2' },
        }),
      );
    }
    const recordQuestion = vi.fn(async () => ({}));
    const handler = createToolGateway({
      createStore: () => store,
      openGraph: async () => ({}),
      closeGraphSource: async () => {},
      createGraphWriter: () => ({ recordQuestion }),
      createGraphManager: () => ({
        withWriter: (fn) => fn({ recordQuestion }),
        close: async () => {},
      }),
      createProcessBridge: createRealProcessBridge,
      broadcastToIntent: async () => {},
      processTable: table,
      now: () => NOW,
      bridgeOptions: { pollIntervalMs: 1, parkGraceMs: 1 },
    });
    const result = await call(handler, {
      tool: 'ask_question',
      args: { questions: [{ text: 'Proceed?', type: 'single', options: [{ label: 'Yes' }] }] },
      headers,
    });
    const records = await store.getExecutionRecords(executionId);
    if (rewound) {
      expect(result.isError).toBe(true);
      expect(records.humanTasks).toHaveLength(0);
      expect(records.stages[0].state).toBe('RUNNING');
    } else {
      expect(result.isError).not.toBe(true);
      expect(records.humanTasks).toHaveLength(1);
      expect(records.humanTasks[0]).toMatchObject({
        orchestratorRunId: 'run-1',
        stageCallbackId: 'cb-1',
      });
    }
  });
});
