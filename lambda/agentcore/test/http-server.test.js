import { describe, it, expect, vi } from 'vitest';
import {
  createBusyTracker,
  dispatchInvocation,
  createServer,
  processStoreFor,
  graphAccessFor,
} from '../http-server.js';
import { createRecordLearningHandler } from '../http-server.js';
import { AGENT_AUTH_MODES, COMMANDS, commandDefinition } from '../command-registry.js';

describe('createBusyTracker', () => {
  it('reports HealthyBusy while work is in flight, Healthy otherwise', () => {
    const b = createBusyTracker();
    expect(b.status).toBe('Healthy');
    b.enter();
    expect(b.status).toBe('HealthyBusy');
    b.enter();
    b.leave();
    expect(b.status).toBe('HealthyBusy');
    b.leave();
    expect(b.status).toBe('Healthy');
  });
});

describe('dispatchInvocation', () => {
  const handlers = {
    initWs: async (p) => ({ ok: true, intentId: p.intentId }),
    runStage: async (p) => ({ ok: true, stageId: p.stageId, state: 'SUCCEEDED' }),
    inspect: async (p) => ({ ok: true, intentId: p.intentId, artifactCount: 0 }),
  };

  it('rejects a missing command', async () => {
    const r = await dispatchInvocation({ payload: {}, handlers });
    expect(r.statusCode).toBe(400);
  });

  it('rejects an unknown command', async () => {
    const r = await dispatchInvocation({ payload: { command: 'nope' }, handlers });
    expect(r.statusCode).toBe(400);
  });

  it('keeps routing and authentication metadata in one command registry', () => {
    expect(COMMANDS['init-ws']).toEqual({
      handler: 'initWs',
      agentAuth: false,
      grantScope: 'execution',
    });
    expect(COMMANDS['run-stage']).toEqual({
      handler: 'runStage',
      agentAuth: AGENT_AUTH_MODES.EXECUTION,
      grantScope: 'stage',
    });
    expect(COMMANDS['compose-plan-start'].agentAuth).toBe(AGENT_AUTH_MODES.COMPOSE);
    expect(COMMANDS['discussion-assist-start'].agentAuth).toBe(AGENT_AUTH_MODES.DISCUSSION);
    expect(COMMANDS.capabilities.agentAuth).toBe(AGENT_AUTH_MODES.CAPABILITIES);
    expect(commandDefinition('toString')).toBeNull();
  });

  it('routes init-ws and run-stage', async () => {
    const a = await dispatchInvocation({
      payload: { command: 'init-ws', intentId: 'i1' },
      handlers,
      now: () => '2026-01-01T00:00:00.000Z',
    });
    expect(a).toMatchObject({
      statusCode: 200,
      body: { ok: true, intentId: 'i1', command: 'init-ws' },
    });
    const b = await dispatchInvocation({
      payload: { command: 'run-stage', stageId: 's1' },
      handlers,
    });
    expect(b).toMatchObject({ statusCode: 200, body: { ok: true, stageId: 's1' } });
    const c = await dispatchInvocation({
      payload: { command: 'inspect', intentId: 'i1' },
      handlers,
    });
    expect(c).toMatchObject({
      statusCode: 200,
      body: { ok: true, intentId: 'i1', command: 'inspect' },
    });
  });

  it('does not prepare agent credentials for engine-only commands', async () => {
    const prepareInvocation = vi.fn(async () => {
      throw new Error('SSM unavailable');
    });
    const result = await dispatchInvocation({
      payload: { command: 'init-ws', intentId: 'i1' },
      handlers,
      prepareInvocation,
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: { ok: true, intentId: 'i1', command: 'init-ws' },
    });
    expect(prepareInvocation).not.toHaveBeenCalled();
  });

  it('prepares agent credentials for CLI-consuming commands', async () => {
    const prepareInvocation = vi.fn(async () => ({ availableClis: ['kiro'] }));
    const runStage = vi.fn(async (_payload, context) => ({
      ok: true,
      availableClis: context.availableClis,
    }));
    const result = await dispatchInvocation({
      payload: {
        command: 'run-stage',
        stageId: 's1',
        agentCredentialGrant: 'signed-grant',
      },
      handlers: { runStage },
      prepareInvocation,
    });

    expect(result).toMatchObject({
      statusCode: 200,
      body: { ok: true, availableClis: ['kiro'], command: 'run-stage' },
    });
    expect(prepareInvocation).toHaveBeenCalledWith(
      {
        command: 'run-stage',
        stageId: 's1',
        agentCredentialGrant: 'signed-grant',
      },
      AGENT_AUTH_MODES.EXECUTION,
    );
    expect(runStage).toHaveBeenCalledWith(
      { command: 'run-stage', stageId: 's1' },
      { availableClis: ['kiro'] },
    );
  });

  it('keeps the gateway grant out of command payloads but available to the invocation', async () => {
    const { currentGatewayGrant } = await import('../mcp/gateway-context.js');
    let seen = null;
    const runStage = vi.fn(async (payload) => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      seen = currentGatewayGrant();
      return { ok: true, payloadKeys: Object.keys(payload) };
    });
    const result = await dispatchInvocation({
      payload: { command: 'run-stage', stageId: 's1', gatewayGrant: 'gw-grant' },
      handlers: { runStage },
      prepareInvocation: vi.fn(async () => ({})),
    });
    expect(result.body.payloadKeys).not.toContain('gatewayGrant');
    expect(seen).toBe('gw-grant');
    expect(currentGatewayGrant()).toBeNull();
  });

  it('relays an execution grant to engine-only commands and their background work', async () => {
    const { currentGatewayGrant } = await import('../mcp/gateway-context.js');
    const prepareInvocation = vi.fn();
    let background;
    const handlerFor = (name) =>
      vi.fn(async (payload) => {
        // A detached job started inside the invocation keeps the grant.
        background = new Promise((resolve) => setTimeout(() => resolve(currentGatewayGrant()), 1));
        return { ok: true, name, seen: currentGatewayGrant(), payloadKeys: Object.keys(payload) };
      });
    for (const [command, handler] of [
      ['init-ws', 'initWs'],
      ['record-pr', 'recordPr'],
      ['quorum-edit-apply-start', 'quorumEditApplyStart'],
    ]) {
      const result = await dispatchInvocation({
        payload: { command, intentId: 'i1', gatewayGrant: `grant-${command}` },
        handlers: { [handler]: handlerFor(handler) },
        prepareInvocation: command === 'init-ws' ? prepareInvocation : vi.fn(async () => ({})),
      });
      expect(result.body).toMatchObject({ ok: true, seen: `grant-${command}` });
      expect(result.body.payloadKeys).not.toContain('gatewayGrant');
      await expect(background).resolves.toBe(`grant-${command}`);
      expect(currentGatewayGrant()).toBeNull();
    }
    expect(prepareInvocation).not.toHaveBeenCalled();
  });

  it('prepares credentials under the invocation grant', async () => {
    const { currentGatewayGrant } = await import('../mcp/gateway-context.js');
    let seenByPrepare = null;
    await dispatchInvocation({
      payload: { command: 'run-stage', executionId: 'e1', gatewayGrant: 'gw-grant' },
      handlers: { runStage: vi.fn(async () => ({ ok: true })) },
      prepareInvocation: vi.fn(async () => {
        seenByPrepare = currentGatewayGrant();
        return {};
      }),
    });
    expect(seenByPrepare).toBe('gw-grant');
    expect(currentGatewayGrant()).toBeNull();
  });

  it('routes promote-units (WP3 unit DAG promotion)', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'promote-units', intentId: 'i1', executionId: 'e1' },
      handlers: {
        promoteUnits: async (p) => ({ ok: true, unitCount: 3, executionId: p.executionId }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: { ok: true, unitCount: 3, executionId: 'e1', command: 'promote-units' },
    });
  });

  it('routes derive-artifacts for fine-grained graph projection', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'derive-artifacts', intentId: 'i1', executionId: 'e1' },
      handlers: {
        deriveArtifacts: async (p) => ({ ok: true, artifacts: ['a1'], executionId: p.executionId }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: { ok: true, artifacts: ['a1'], executionId: 'e1', command: 'derive-artifacts' },
    });
  });

  it('routes workflow checkpoint publication', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'create-workflow-checkpoint', intentId: 'i1', executionId: 'e1' },
      handlers: {
        createWorkflowCheckpoint: async (p) => ({
          ok: true,
          checkpointId: 'cp1',
          executionId: p.executionId,
        }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        checkpointId: 'cp1',
        executionId: 'e1',
        command: 'create-workflow-checkpoint',
      },
    });
  });

  it('dispatches record-learning to the registered AgentCore handler', async () => {
    const recordLearning = vi.fn(async (payload) => ({
      ok: true,
      learningCount: payload.learnings.length,
    }));

    const response = await dispatchInvocation({
      payload: { command: 'record-learning', learnings: ['Keep gate receipts attempt-scoped'] },
      handlers: { recordLearning },
    });

    expect(response).toMatchObject({
      statusCode: 200,
      body: { ok: true, learningCount: 1, command: 'record-learning' },
    });
    expect(recordLearning).toHaveBeenCalledWith(
      { command: 'record-learning', learnings: ['Keep gate receipts attempt-scoped'] },
      {},
    );
  });

  it('binds record-learning to the project-scoped runtime dependencies', async () => {
    const store = { name: 'store' };
    const openGraph = vi.fn(async () => ({ name: 'graph' }));
    const broadcast = vi.fn();
    const recordLearning = vi.fn(async () => ({ ok: true, recorded: true }));
    const response = await dispatchInvocation({
      payload: { command: 'record-learning', learnings: ['Prefer explicit retries'] },
      handlers: {
        recordLearning: createRecordLearningHandler({
          recordLearning,
          store,
          openGraph,
          broadcast,
        }),
      },
    });

    expect(response.body).toMatchObject({ ok: true, recorded: true });
    expect(recordLearning).toHaveBeenCalledWith(
      { command: 'record-learning', learnings: ['Prefer explicit retries'] },
      { store, openGraph, broadcast },
    );
  });

  it('routes discussion-assist-start for Quorum discussion jobs', async () => {
    const r = await dispatchInvocation({
      payload: {
        command: 'discussion-assist-start',
        intentId: 'i1',
        discussionId: 'd1',
        requestId: 'r1',
      },
      handlers: {
        discussionAssistStart: async (p) => ({
          ok: true,
          accepted: true,
          requestId: p.requestId,
        }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: {
        ok: true,
        accepted: true,
        requestId: 'r1',
        command: 'discussion-assist-start',
      },
    });
  });

  it('routes record-pr (fan-in PR graph record)', async () => {
    const r = await dispatchInvocation({
      payload: {
        command: 'record-pr',
        intentId: 'i1',
        executionId: 'e1',
        prs: [{ repoId: 'o/r' }],
      },
      handlers: {
        recordPr: async (p) => ({ ok: true, recorded: p.prs, executionId: p.executionId }),
      },
    });
    expect(r).toMatchObject({
      statusCode: 200,
      body: { ok: true, executionId: 'e1', command: 'record-pr' },
    });
  });

  it('routes record-unit-pr without using the final PR handler', async () => {
    const recordPr = vi.fn();
    const recordUnitPr = vi.fn(async (payload) => ({
      ok: true,
      recorded: payload.unitPrs,
    }));
    const result = await dispatchInvocation({
      payload: {
        command: 'record-unit-pr',
        intentId: 'i1',
        executionId: 'e1',
        unitPrs: [{ unitSlug: 'auth', prNumber: 7 }],
      },
      handlers: { recordPr, recordUnitPr },
    });
    expect(result).toMatchObject({
      statusCode: 200,
      body: { ok: true, command: 'record-unit-pr' },
    });
    expect(recordUnitPr).toHaveBeenCalledOnce();
    expect(recordPr).not.toHaveBeenCalled();
  });

  it('routes init-lane and merge-lane (WP5 unit lanes)', async () => {
    const laneHandlers = {
      initLane: async (p) => ({ ok: true, unitSlug: p.unitSlug }),
      mergeLane: async (p) => ({ ok: false, reason: 'merge_conflict', unitSlug: p.unitSlug }),
    };
    const a = await dispatchInvocation({
      payload: { command: 'init-lane', unitSlug: 'auth' },
      handlers: laneHandlers,
    });
    expect(a).toMatchObject({
      statusCode: 200,
      body: { ok: true, unitSlug: 'auth', command: 'init-lane' },
    });
    // A merge conflict is an ok:false VALUE, not an HTTP transport failure.
    const b = await dispatchInvocation({
      payload: { command: 'merge-lane', unitSlug: 'auth' },
      handlers: laneHandlers,
    });
    expect(b).toMatchObject({
      statusCode: 200,
      body: { ok: false, reason: 'merge_conflict', command: 'merge-lane' },
    });
  });

  it('keeps a handler ok:false on 200 so callers receive the failure body', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: { runStage: async () => ({ ok: false, reason: 'no_cli' }) },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body.reason).toBe('no_cli');
  });

  it('maps a thrown handler to 500', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'init-ws' },
      handlers: {
        initWs: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(r.statusCode).toBe(500);
    expect(r.body.error).toBe('boom');
  });

  it('returns to Healthy after a parked run-stage dispatch (no longer pinned busy)', async () => {
    const busy = createBusyTracker();
    // ask_question now parks, so run-stage returns promptly with WAITING_FOR_HUMAN
    // instead of blocking — busy.leave() fires and /ping can report Healthy.
    await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: {
        runStage: async () => ({ ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'q-1' }),
      },
      busy,
    });
    expect(busy.status).toBe('Healthy');
  });

  it('flips busy during the handler', async () => {
    const busy = createBusyTracker();
    let statusDuring;
    await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: {
        runStage: async () => {
          statusDuring = busy.status;
          return { ok: true };
        },
      },
      busy,
    });
    expect(statusDuring).toBe('HealthyBusy');
    expect(busy.status).toBe('Healthy');
  });
});

// End-to-end over a real socket: /ping and /invocations.
describe('createServer (http)', () => {
  const handlers = {
    initWs: async () => ({ ok: true }),
    runStage: async () => ({ ok: true, state: 'SUCCEEDED' }),
  };

  const listen = (server) =>
    new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  it('serves /ping with a status', async () => {
    const server = createServer({ handlers });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/ping`);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.status).toBe('Healthy');
    server.close();
  });

  it('serves POST /invocations', async () => {
    const server = createServer({ handlers });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'run-stage', stageId: 's1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, command: 'run-stage' });
    server.close();
  });

  it('404s an unknown route', async () => {
    const server = createServer({ handlers });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
    server.close();
  });
});

describe('processStoreFor', () => {
  const local = { kind: 'local' };
  const deps = {
    ddb: 'ddb',
    createLocal: vi.fn(() => local),
    createRemote: vi.fn(() => ({ kind: 'remote' })),
    misconfigured: vi.fn(() => ({ kind: 'misconfigured' })),
  };

  it('keeps the local store when engine-data is off', () => {
    expect(processStoreFor({ ...deps, env: { V2_PROCESS_TABLE: 't' } })).toBe(local);
    expect(deps.createLocal).toHaveBeenCalledWith({ ddb: 'ddb', tableName: 't' });
  });

  it('routes the store to engine-data under the current grant', async () => {
    const { currentGatewayGrant } = await import('../mcp/gateway-context.js');
    const store = processStoreFor({
      ...deps,
      env: { ENGINE_DATA_FUNCTION: 'fn', AIDLC_MCP_GATEWAY_URL: 'https://gw/mcp' },
    });
    expect(store).toEqual({ kind: 'remote' });
    expect(deps.createRemote).toHaveBeenCalledWith({ grant: currentGatewayGrant });
  });

  it('fails closed when engine-data is on but the MCP still runs locally', () => {
    expect(processStoreFor({ ...deps, env: { ENGINE_DATA_FUNCTION: 'fn' } })).toEqual({
      kind: 'misconfigured',
    });
  });
});

describe('graphAccessFor', () => {
  const openGraph = vi.fn(async () => ({}));
  const REMOTE_ENV = { ENGINE_DATA_FUNCTION: 'fn', AIDLC_MCP_GATEWAY_URL: 'https://gw/mcp' };

  it('keeps the direct graph and runs the engine operations locally when engine-data is off', () => {
    const local = vi.fn();
    const access = graphAccessFor({ env: {}, openGraph, createLocal: () => local });
    expect(access).toEqual({ engineData: false, openGraph, openEngineGraph: local });
  });

  it('routes engine graph operations to engine-data and trips any direct graph open', async () => {
    const { currentGatewayGrant } = await import('../mcp/gateway-context.js');
    const remote = vi.fn();
    const createRemote = vi.fn(() => remote);
    const access = graphAccessFor({ env: REMOTE_ENV, openGraph, createRemote });
    expect(access.engineData).toBe(true);
    expect(access.openEngineGraph).toBe(remote);
    expect(createRemote).toHaveBeenCalledWith({ grant: currentGatewayGrant });
    await expect(access.openGraph()).rejects.toMatchObject({ code: 'ENGINE_DATA_GRAPH_DIRECT' });
    expect(openGraph).not.toHaveBeenCalled();
  });

  it('fails closed without the MCP Gateway instead of falling back to the direct graph', async () => {
    const access = graphAccessFor({ env: { ENGINE_DATA_FUNCTION: 'fn' }, openGraph });
    await expect(access.openEngineGraph({ intentId: 'i1' })).rejects.toMatchObject({
      code: 'ENGINE_DATA_MISCONFIGURED',
    });
    await expect(access.openGraph()).rejects.toMatchObject({ code: 'ENGINE_DATA_GRAPH_DIRECT' });
    expect(openGraph).not.toHaveBeenCalled();
  });
});
