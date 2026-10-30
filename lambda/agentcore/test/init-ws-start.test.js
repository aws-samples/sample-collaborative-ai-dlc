import { describe, it, expect, vi } from 'vitest';
import { createInitWsStart, normalizeInitResult } from '../commands/init-ws-start.js';
import { createBusyTracker, dispatchInvocation } from '../http-server.js';

// Async workspace initialization: init-ws as a background job so a large clone
// is not bounded by the orchestrator Lambda. The command must accept fast,
// ALWAYS complete the durable callback with init-ws's {ok, reason, detail},
// heartbeat while the clone runs, hold the busy tracker for the job's
// lifetime, and never let two clones race into one workspace.

const flush = () => new Promise((r) => setTimeout(r, 0));

const makeGate = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const basePayload = {
  command: 'init-ws-start',
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  repos: ['acme/api'],
  branch: 'aidlc/i1',
  orchestratorRunId: 'run-1',
  callbackId: 'cb-init',
};

const quietLog = { info: () => {}, warn: vi.fn(), error: vi.fn() };

const makeDeps = (over = {}) => {
  const sent = [];
  const beats = [];
  return {
    sent,
    beats,
    deps: {
      initWs: vi.fn(async () => ({ ok: true, intentId: 'i1', executionId: 'e1', repos: [] })),
      sendCallbackSuccess: vi.fn(async (callbackId, result) => {
        sent.push({ callbackId, result });
        return { delivered: true };
      }),
      sendCallbackHeartbeat: vi.fn(async (callbackId) => {
        beats.push(callbackId);
        return { delivered: true };
      }),
      log: { ...quietLog, warn: vi.fn(), error: vi.fn() },
      ...over,
    },
  };
};

describe('normalizeInitResult', () => {
  it("passes through init-ws's own success and failure shapes", () => {
    expect(normalizeInitResult({ ok: true, repos: [] })).toEqual({ ok: true, repos: [] });
    expect(normalizeInitResult({ ok: false, reason: 'checkout_failed' })).toEqual({
      ok: false,
      reason: 'checkout_failed',
    });
  });

  it('turns a result without an ok flag into a failure, never a ready workspace', () => {
    expect(normalizeInitResult(undefined)).toMatchObject({
      ok: false,
      reason: 'init_ws_no_result',
    });
    expect(normalizeInitResult({ repos: [] })).toMatchObject({ ok: false });
  });
});

describe('createInitWsStart', () => {
  it('refuses the capability probe (no callbackId) without starting a job', async () => {
    const { deps } = makeDeps();
    const start = createInitWsStart(deps);
    const res = await start({ command: 'init-ws-start', executionId: 'e1' });
    expect(res).toEqual({ ok: false, reason: 'missing_callback_id' });
    expect(deps.initWs).not.toHaveBeenCalled();
    expect(deps.sendCallbackHeartbeat).not.toHaveBeenCalled();
  });

  it('rejects a payload without executionId', async () => {
    const { deps } = makeDeps();
    const res = await createInitWsStart(deps)({ callbackId: 'cb-1' });
    expect(res).toEqual({ ok: false, reason: 'missing_execution_id' });
    expect(deps.initWs).not.toHaveBeenCalled();
  });

  it('accepts while the clone is still running, then completes the callback with the init verdict', async () => {
    const gate = makeGate();
    const { deps, sent } = makeDeps({ initWs: vi.fn(() => gate.promise) });
    const start = createInitWsStart(deps);

    const res = await start(basePayload);
    expect(res).toMatchObject({ ok: true, accepted: true, callbackId: 'cb-init' });
    expect(sent).toHaveLength(0);
    expect(start.activeJobs.size).toBe(1);

    gate.resolve({ ok: true, intentId: 'i1', executionId: 'e1', repos: ['acme/api'] });
    await flush();

    expect(sent).toEqual([
      {
        callbackId: 'cb-init',
        result: { ok: true, intentId: 'i1', executionId: 'e1', repos: ['acme/api'] },
      },
    ]);
    expect(start.activeJobs.size).toBe(0);
  });

  it('hands init-ws its own arguments, without the transport fields', async () => {
    const { deps } = makeDeps();
    await createInitWsStart(deps)(basePayload);
    await flush();
    const arg = deps.initWs.mock.calls[0][0];
    expect(arg).toMatchObject({ executionId: 'e1', branch: 'aidlc/i1', repos: ['acme/api'] });
    expect(arg).not.toHaveProperty('callbackId');
    expect(arg).not.toHaveProperty('command');
  });

  it('delivers an init-ws failure through the callback and logs its detail', async () => {
    const failure = {
      ok: false,
      reason: 'intent_branch_push_failed',
      detail: 'acme/api (base master: push_failed)',
    };
    const { deps, sent } = makeDeps({ initWs: vi.fn(async () => failure) });
    await createInitWsStart(deps)(basePayload);
    await flush();
    expect(sent).toEqual([{ callbackId: 'cb-init', result: failure }]);
    // The synchronous path logs failures in dispatchInvocation; the background
    // job must keep that diagnosable record.
    expect(deps.log.warn).toHaveBeenCalledWith(
      'command returned failure',
      expect.objectContaining({
        reason: 'intent_branch_push_failed',
        detail: 'acme/api (base master: push_failed)',
      }),
    );
  });

  it('completes the callback even when init-ws throws', async () => {
    const { deps, sent } = makeDeps({
      initWs: vi.fn(async () => {
        throw new Error('ENOSPC: no space left on device');
      }),
    });
    const start = createInitWsStart(deps);
    await start(basePayload);
    await flush();
    expect(sent).toEqual([
      {
        callbackId: 'cb-init',
        result: {
          ok: false,
          reason: 'init_ws_job_crashed',
          detail: 'ENOSPC: no space left on device',
        },
      },
    ]);
    expect(start.activeJobs.size).toBe(0);
  });

  it('establishes the heartbeat before cloning and fails the dispatch when it cannot', async () => {
    const { deps } = makeDeps({
      sendCallbackHeartbeat: vi.fn(async () => ({ delivered: false, error: 'AccessDenied' })),
    });
    const start = createInitWsStart(deps);
    const res = await start(basePayload);
    expect(res).toEqual({
      ok: false,
      reason: 'init_ws_callback_heartbeat_failed',
      detail: 'AccessDenied',
    });
    expect(deps.initWs).not.toHaveBeenCalled();
    expect(start.activeJobs.size).toBe(0);
  });

  it('keeps heartbeating while a long clone runs', async () => {
    vi.useFakeTimers();
    try {
      const gate = makeGate();
      const { deps, beats } = makeDeps({ initWs: vi.fn(() => gate.promise) });
      const start = createInitWsStart({ ...deps, heartbeatIntervalMs: 1_000 });
      await start(basePayload);
      expect(beats).toEqual(['cb-init']); // the synchronous first beat
      await vi.advanceTimersByTimeAsync(3_500);
      expect(beats.length).toBe(4);
      gate.resolve({ ok: true });
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(5_000);
      // Heartbeats stop once the job completes.
      expect(beats.length).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('acknowledges a duplicate dispatch of the SAME init attempt without a second clone', async () => {
    const gate = makeGate();
    const { deps } = makeDeps({ initWs: vi.fn(() => gate.promise) });
    const start = createInitWsStart(deps);
    await start(basePayload);
    const again = await start(basePayload);
    expect(again).toMatchObject({ ok: true, accepted: true, alreadyRunning: true });
    expect(deps.initWs).toHaveBeenCalledTimes(1);
    gate.resolve({ ok: true });
    await flush();
  });

  it('refuses a DIFFERENT init attempt while a clone is still writing the workspace', async () => {
    const gate = makeGate();
    const { deps } = makeDeps({ initWs: vi.fn(() => gate.promise) });
    const start = createInitWsStart(deps);
    await start(basePayload);
    const relaunch = await start({ ...basePayload, callbackId: 'cb-relaunch' });
    expect(relaunch).toEqual({
      ok: false,
      reason: 'init_job_already_running',
      detail: 'e1:init-ws',
    });
    expect(deps.initWs).toHaveBeenCalledTimes(1);
    gate.resolve({ ok: true });
    await flush();
    // Once the first job finishes, a new attempt is accepted again.
    const later = await start({ ...basePayload, callbackId: 'cb-relaunch' });
    expect(later).toMatchObject({ ok: true, accepted: true });
    await flush();
  });

  describe('dispatches that overlap the first heartbeat', () => {
    const makeOverlap = () => {
      const beat = makeGate();
      const clone = makeGate();
      const { deps } = makeDeps({
        initWs: vi.fn(() => clone.promise),
        sendCallbackHeartbeat: vi.fn(() => beat.promise),
      });
      return { beat, clone, deps, start: createInitWsStart(deps) };
    };

    it('runs one clone for two dispatches of the SAME attempt, both accepted', async () => {
      const { beat, clone, deps, start } = makeOverlap();
      const first = start(basePayload);
      const second = start(basePayload);
      beat.resolve({ delivered: true });
      await expect(first).resolves.toMatchObject({ ok: true, accepted: true });
      await expect(second).resolves.toMatchObject({
        ok: true,
        accepted: true,
        alreadyRunning: true,
      });
      expect(deps.sendCallbackHeartbeat).toHaveBeenCalledTimes(1);
      expect(deps.initWs).toHaveBeenCalledTimes(1);
      clone.resolve({ ok: true });
      await flush();
      expect(start.activeJobs.size).toBe(0);
    });

    it('refuses a DIFFERENT attempt while the first heartbeat is pending', async () => {
      const { beat, clone, deps, start } = makeOverlap();
      const first = start(basePayload);
      const relaunch = await start({ ...basePayload, callbackId: 'cb-relaunch' });
      expect(relaunch).toEqual({
        ok: false,
        reason: 'init_job_already_running',
        detail: 'e1:init-ws',
      });
      beat.resolve({ delivered: true });
      await expect(first).resolves.toMatchObject({ ok: true, accepted: true });
      expect(deps.initWs).toHaveBeenCalledTimes(1);
      clone.resolve({ ok: true });
      await flush();
    });

    it('shares a failed first heartbeat with the duplicate and frees the workspace', async () => {
      const { beat, deps, start } = makeOverlap();
      const first = start(basePayload);
      const second = start(basePayload);
      beat.resolve({ delivered: false, error: 'AccessDenied' });
      const failure = {
        ok: false,
        reason: 'init_ws_callback_heartbeat_failed',
        detail: 'AccessDenied',
      };
      await expect(first).resolves.toEqual(failure);
      await expect(second).resolves.toEqual(failure);
      expect(deps.initWs).not.toHaveBeenCalled();
      expect(start.activeJobs.size).toBe(0);
    });
  });

  it("a finished job's cleanup never removes another job's reservation", async () => {
    const clone = makeGate();
    const { deps } = makeDeps({ initWs: vi.fn(() => clone.promise) });
    const start = createInitWsStart(deps);
    await start(basePayload);
    // Simulate a later attempt owning the entry when the first job ends.
    const other = { callbackId: 'cb-other' };
    start.activeJobs.set('e1:init-ws', other);
    clone.resolve({ ok: true });
    await flush();
    expect(start.activeJobs.get('e1:init-ws')).toBe(other);
  });

  describe('a dispatch retry after the job finished', () => {
    it('answers alreadyCompleted without a second clone or a heartbeat to the completed callback', async () => {
      const { deps, sent, beats } = makeDeps();
      const start = createInitWsStart(deps);
      await start(basePayload);
      await flush();
      expect(sent).toHaveLength(1);

      const retry = await start(basePayload);

      expect(retry).toEqual({
        ok: true,
        accepted: true,
        alreadyCompleted: true,
        callbackId: 'cb-init',
      });
      expect(deps.initWs).toHaveBeenCalledOnce();
      expect(beats).toEqual(['cb-init']);
      expect(sent).toHaveLength(1);
    });

    it('starts a new job for a DIFFERENT callback once the previous one finished', async () => {
      const { deps } = makeDeps();
      const start = createInitWsStart(deps);
      await start(basePayload);
      await flush();

      const next = await start({ ...basePayload, callbackId: 'cb-next' });
      await flush();

      expect(next).toMatchObject({ ok: true, accepted: true, callbackId: 'cb-next' });
      expect(next).not.toHaveProperty('alreadyCompleted');
      expect(deps.initWs).toHaveBeenCalledTimes(2);
    });

    it('forgets a finished callback after the retention window', async () => {
      let clock = 1_000;
      const { deps } = makeDeps();
      const start = createInitWsStart({ ...deps, completedRetentionMs: 100, now: () => clock });
      await start(basePayload);
      await flush();
      clock += 101;

      const late = await start(basePayload);
      await flush();

      expect(late).not.toHaveProperty('alreadyCompleted');
      expect(deps.initWs).toHaveBeenCalledTimes(2);
    });
  });

  it('holds the busy tracker for the whole job so the session stays HealthyBusy', async () => {
    const gate = makeGate();
    const busy = createBusyTracker();
    const { deps } = makeDeps({ initWs: vi.fn(() => gate.promise) });
    await createInitWsStart({ ...deps, busy })(basePayload);
    expect(busy.status).toBe('HealthyBusy');
    gate.resolve({ ok: true });
    await flush();
    expect(busy.status).toBe('Healthy');
  });
});

describe('init-ws-start through dispatchInvocation', () => {
  it('is routed by the command registry and returns the accept on HTTP 200', async () => {
    const { deps } = makeDeps();
    const start = createInitWsStart(deps);
    const res = await dispatchInvocation({
      payload: basePayload,
      handlers: { initWsStart: start },
      busy: createBusyTracker(),
      now: () => 'T',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ ok: true, accepted: true, command: 'init-ws-start' });
    await flush();
  });

  it('answers the probe on HTTP 200, so the orchestrator can tell it from an older image', async () => {
    const { deps } = makeDeps();
    const res = await dispatchInvocation({
      payload: { command: 'init-ws-start', executionId: 'e1' },
      handlers: { initWsStart: createInitWsStart(deps) },
      busy: createBusyTracker(),
      now: () => 'T',
    });
    expect(res).toEqual({
      statusCode: 200,
      body: { ok: false, reason: 'missing_callback_id', command: 'init-ws-start', at: 'T' },
    });
  });

  it('an image without the handler answers 400 unknown command (the older-image signal)', async () => {
    const res = await dispatchInvocation({
      payload: { command: 'init-ws-start', executionId: 'e1' },
      handlers: {},
      busy: createBusyTracker(),
    });
    expect(res).toEqual({ statusCode: 400, body: { error: 'unknown command "init-ws-start"' } });
  });
});
