import { describe, it, expect } from 'vitest';
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
  });

  it('maps a handler ok:false to 422', async () => {
    const r = await dispatchInvocation({
      payload: { command: 'run-stage' },
      handlers: { runStage: async () => ({ ok: false, reason: 'no_cli' }) },
    });
    expect(r.statusCode).toBe(422);
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
