import { describe, it, expect, vi } from 'vitest';
import { createRunStageStart, normalizeStageResult } from '../commands/run-stage-start.js';
import { createBusyTracker, dispatchInvocation } from '../http-server.js';

// WP1 (docs/v2-parallel.md): the async stage invocation. The command must
// accept fast, run the stage as a background job, ALWAYS complete the durable
// callback (success, failure, crash), heartbeat while running, hold the busy
// tracker for the job's lifetime, and refuse duplicate starts.

const flush = () => new Promise((r) => setTimeout(r, 0));

// A controllable runStage: resolves/rejects when the test decides.
const makeGate = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

const basePayload = {
  command: 'run-stage-start',
  executionId: 'e1',
  intentId: 'i1',
  stageId: 's1',
  stageCallbackId: 'cb-123',
};

const makeDeps = (over = {}) => {
  const sent = [];
  const beats = [];
  return {
    sent,
    beats,
    deps: {
      runStage: vi.fn(async () => ({ ok: true, state: 'SUCCEEDED', stageInstanceId: 'si-1' })),
      sendCallbackSuccess: vi.fn(async (callbackId, result) => {
        sent.push({ callbackId, result });
        return { delivered: true };
      }),
      sendCallbackHeartbeat: vi.fn(async (callbackId) => {
        beats.push(callbackId);
        return { delivered: true };
      }),
      ...over,
    },
  };
};

describe('normalizeStageResult', () => {
  it('passes through results that already carry a state', () => {
    expect(
      normalizeStageResult({ ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' }),
    ).toEqual({ ok: true, state: 'WAITING_FOR_HUMAN', humanTaskId: 'h1' });
  });

  it("adds state FAILED to run-stage's stateless failure shape", () => {
    expect(normalizeStageResult({ ok: false, reason: 'no_cli', detail: 'x' })).toEqual({
      ok: false,
      state: 'FAILED',
      reason: 'no_cli',
      detail: 'x',
    });
  });

  it('adds state SUCCEEDED to an ok result without state', () => {
    expect(normalizeStageResult({ ok: true }).state).toBe('SUCCEEDED');
  });

  it('converts a non-object result into a FAILED verdict', () => {
    expect(normalizeStageResult(undefined)).toMatchObject({
      ok: false,
      state: 'FAILED',
      reason: 'stage_no_result',
    });
  });
});

describe('createRunStageStart', () => {
  it('rejects a payload without stageCallbackId (fail fast, no job)', async () => {
    const { deps } = makeDeps();
    const start = createRunStageStart(deps);
    const res = await start({ ...basePayload, stageCallbackId: undefined });
    expect(res).toMatchObject({ ok: false, reason: 'missing_stage_callback_id' });
    expect(deps.runStage).not.toHaveBeenCalled();
  });

  it('rejects a payload without executionId/stageId', async () => {
    const { deps } = makeDeps();
    const start = createRunStageStart(deps);
    const res = await start({ command: 'run-stage-start', stageCallbackId: 'cb-1' });
    expect(res).toMatchObject({ ok: false, reason: 'missing_stage_identity' });
  });

  it('accepts immediately while the stage is still running, then completes the callback with the result', async () => {
    const gate = makeGate();
    const { deps, sent } = makeDeps({ runStage: vi.fn(() => gate.promise) });
    const start = createRunStageStart(deps);

    const res = await start(basePayload);
    expect(res).toMatchObject({
      ok: true,
      accepted: true,
      stageId: 's1',
      stageCallbackId: 'cb-123',
    });
    // Accepted, but no verdict yet — the job is in flight.
    expect(sent).toHaveLength(0);
    expect(start.activeJobs.size).toBe(1);

    gate.resolve({ ok: true, state: 'SUCCEEDED', stageInstanceId: 'si-1', cli: 'claude' });
    await flush();

    expect(sent).toEqual([
      {
        callbackId: 'cb-123',
        result: { ok: true, state: 'SUCCEEDED', stageInstanceId: 'si-1', cli: 'claude' },
      },
    ]);
    expect(start.activeJobs.size).toBe(0);
  });

  it('normalizes a stateless run-stage failure before completing the callback', async () => {
    const { deps, sent } = makeDeps({
      runStage: vi.fn(async () => ({ ok: false, reason: 'sensor_blocked', detail: 'lint' })),
    });
    const start = createRunStageStart(deps);
    await start(basePayload);
    await flush();
    expect(sent[0].result).toEqual({
      ok: false,
      state: 'FAILED',
      reason: 'sensor_blocked',
      detail: 'lint',
    });
  });

  it('a crashing run-stage still completes the callback with stage_job_crashed', async () => {
    const { deps, sent } = makeDeps({
      runStage: vi.fn(async () => {
        throw new Error('DDB exploded');
      }),
    });
    const start = createRunStageStart({ ...deps, log: () => {} });
    await start(basePayload);
    await flush();
    expect(sent[0].result).toEqual({
      ok: false,
      state: 'FAILED',
      reason: 'stage_job_crashed',
      detail: 'DDB exploded',
    });
  });

  it('refuses a duplicate start for the same stage attempt while the job is in flight', async () => {
    const gate = makeGate();
    const { deps, sent } = makeDeps({ runStage: vi.fn(() => gate.promise) });
    const start = createRunStageStart(deps);

    const first = await start(basePayload);
    expect(first.ok).toBe(true);
    // Same attempt + SAME callbackId → idempotent accept (a durable dispatch
    // step retried after a lost response must not fail the stage).
    const retried = await start(basePayload);
    expect(retried).toMatchObject({ ok: true, accepted: true, alreadyRunning: true });
    // Same attempt but a DIFFERENT callbackId → genuine conflict, refused.
    const dup = await start({ ...basePayload, stageCallbackId: 'cb-other' });
    expect(dup).toMatchObject({ ok: false, reason: 'job_already_running' });
    expect(deps.runStage).toHaveBeenCalledTimes(1);

    // A DIFFERENT attempt (resume leg) is not a duplicate.
    const resume = await start({ ...basePayload, resumeFrom: 'h1', stageCallbackId: 'cb-456' });
    expect(resume.ok).toBe(true);

    // A DIFFERENT unit lane's instance of the same stage is not a duplicate
    // (docs/v2-parallel.md WP4: one job per stage attempt PER LANE).
    const lane = await start({ ...basePayload, unitSlug: 'auth', stageCallbackId: 'cb-789' });
    expect(lane.ok).toBe(true);
    expect(lane.jobKey).toContain(':auth:');
    // …and a duplicate WITHIN that lane is still refused.
    const laneDup = await start({ ...basePayload, unitSlug: 'auth', stageCallbackId: 'cb-999' });
    expect(laneDup).toMatchObject({ ok: false, reason: 'job_already_running' });

    gate.resolve({ ok: true, state: 'SUCCEEDED' });
    await flush();
    // After completion the slot frees up for a retry.
    expect(sent.length).toBeGreaterThanOrEqual(1);
    const again = await start(basePayload);
    expect(again.ok).toBe(true);
  });

  it('holds the busy tracker for the whole job lifetime (HealthyBusy while running)', async () => {
    const gate = makeGate();
    const busy = createBusyTracker();
    const { deps } = makeDeps({ runStage: vi.fn(() => gate.promise) });
    const start = createRunStageStart({ ...deps, busy });

    // Simulate the real dispatch path: dispatchInvocation wraps the ACCEPT in
    // enter/leave; the background job must keep busy held after the accept
    // returns.
    const r = await dispatchInvocation({
      payload: basePayload,
      handlers: { runStageStart: start },
      busy,
    });
    expect(r.statusCode).toBe(200);
    expect(busy.status).toBe('HealthyBusy'); // accept returned, job still running

    gate.resolve({ ok: true, state: 'SUCCEEDED' });
    await flush();
    expect(busy.status).toBe('Healthy');
  });

  it('heartbeats the callback while the job runs and stops after completion', async () => {
    vi.useFakeTimers();
    try {
      const gate = makeGate();
      const { deps, beats } = makeDeps({ runStage: vi.fn(() => gate.promise) });
      const start = createRunStageStart({ ...deps, heartbeatIntervalMs: 1000 });
      await start(basePayload);

      await vi.advanceTimersByTimeAsync(3500);
      expect(beats.length).toBe(3);
      expect(beats[0]).toBe('cb-123');

      gate.resolve({ ok: true, state: 'SUCCEEDED' });
      await vi.advanceTimersByTimeAsync(1);
      const settled = beats.length;
      await vi.advanceTimersByTimeAsync(5000);
      expect(beats.length).toBe(settled); // no beats after the job ends
    } finally {
      vi.useRealTimers();
    }
  });

  it('logs loudly when the callback cannot be delivered (orchestrator backstop takes over)', async () => {
    const logged = [];
    const { deps } = makeDeps({
      sendCallbackSuccess: vi.fn(async () => ({ delivered: false, error: 'AccessDenied' })),
    });
    const start = createRunStageStart({ ...deps, log: (...a) => logged.push(a.join(' ')) });
    await start(basePayload);
    await flush();
    expect(logged.some((l) => l.includes('FAILED to deliver stage callback'))).toBe(true);
    // The job still cleans up.
    expect(start.activeJobs.size).toBe(0);
  });

  it('routes through dispatchInvocation as command run-stage-start', async () => {
    const { deps } = makeDeps();
    const start = createRunStageStart(deps);
    const r = await dispatchInvocation({
      payload: basePayload,
      handlers: { runStageStart: start },
    });
    expect(r.statusCode).toBe(200);
    expect(r.body).toMatchObject({ ok: true, accepted: true, command: 'run-stage-start' });
    await flush();
  });
});
