import { describe, it, expect, vi } from 'vitest';
import { createBusyTracker, dispatchInvocation, createServer } from '../http-server.js';

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
