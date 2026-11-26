import { describe, it, expect, vi } from 'vitest';
import { createBusyTracker, dispatchInvocation, createServer } from '../http-server.js';
import { AGENT_AUTH_MODES, COMMANDS, commandDefinition } from '../command-registry.js';
import { createRunStageStart } from '../commands/run-stage-start.js';

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
    expect(COMMANDS['init-ws']).toEqual({ handler: 'initWs', agentAuth: false });
    expect(COMMANDS['run-stage']).toEqual({
      handler: 'runStage',
      agentAuth: AGENT_AUTH_MODES.EXECUTION,
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

  it('serves repeated idle pings without advancing an activity timestamp', async () => {
    const now = vi.fn();
    const server = createServer({ handlers, now });
    const port = await listen(server);
    try {
      for (const at of [
        '2026-01-01T00:00:00.000Z',
        '2026-01-01T00:15:00.000Z',
        '2026-01-01T01:00:00.000Z',
      ]) {
        now.mockReturnValue(at);
        const res = await fetch(`http://127.0.0.1:${port}/ping`);
        expect(res.status).toBe(200);
        expect(await res.json()).toEqual({ status: 'Healthy' });
      }
      expect(now).not.toHaveBeenCalled();
    } finally {
      server.close();
    }
  });

  it('keeps /ping HealthyBusy after acceptance until all background stages finish', async () => {
    const busy = createBusyTracker();
    const finishStages = [];
    const runStageStart = createRunStageStart({
      busy,
      runStage: () => new Promise((resolve) => finishStages.push(resolve)),
      sendCallbackSuccess: async () => ({ delivered: true }),
      sendCallbackHeartbeat: async () => ({ delivered: true }),
      log: vi.fn(),
    });
    const server = createServer({ handlers: { runStageStart }, busy });
    const port = await listen(server);
    const ping = async () => {
      const res = await fetch(`http://127.0.0.1:${port}/ping`);
      expect(res.status).toBe(200);
      return res.json();
    };

    try {
      expect(await ping()).toEqual({ status: 'Healthy' });
      for (const stageId of ['s1', 's2']) {
        const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            command: 'run-stage-start',
            executionId: 'e1',
            stageId,
            stageCallbackId: `cb-${stageId}`,
          }),
        });
        expect(res.status).toBe(200);
        expect(await res.json()).toMatchObject({ ok: true, accepted: true });
        expect(await ping()).toEqual({ status: 'HealthyBusy' });
      }

      finishStages[0]({ ok: true, state: 'SUCCEEDED' });
      await vi.waitFor(() => expect(runStageStart.activeJobs.size).toBe(1));
      expect(await ping()).toEqual({ status: 'HealthyBusy' });

      finishStages[1]({ ok: true, state: 'WAITING_FOR_HUMAN' });
      await vi.waitFor(() => expect(runStageStart.activeJobs.size).toBe(0));
      expect(await ping()).toEqual({ status: 'Healthy' });
    } finally {
      for (const finish of finishStages) finish({ ok: true, state: 'SUCCEEDED' });
      server.close();
      await vi.waitFor(() => expect(runStageStart.activeJobs.size).toBe(0));
    }
  });

  it('serves POST /invocations', async () => {
    const at = '2026-01-01T00:00:00.000Z';
    const server = createServer({ handlers, now: () => at });
    const port = await listen(server);
    const res = await fetch(`http://127.0.0.1:${port}/invocations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: 'run-stage', stageId: 's1' }),
    });
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toMatchObject({ ok: true, command: 'run-stage', at });
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
