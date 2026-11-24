import { EventEmitter } from 'node:events';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCliOutputSink } from '../output-normalizer.js';
import { createUsageRecorder } from '../cli/usage-recorder.js';
import { resetKiroCreditRateCache } from '../cli/kiro-usage.js';
import { parseOpenCodeJsonl } from '../cli/opencode-parser.js';
import { parseCodexJsonl } from '../cli/codex-parser.js';

beforeEach(() => resetKiroCreditRateCache());
afterEach(() => vi.useRealTimers());

const cases = [
  [
    'claude',
    [
      {
        type: 'result',
        usage: { input_tokens: 8, output_tokens: 20, cache_read_input_tokens: 100 },
      },
    ],
    { tokensInput: 8, tokensOutput: 20, tokensCacheRead: 100 },
  ],
  [
    'opencode',
    [
      {
        type: 'step_finish',
        part: { tokens: { input: 8, output: 20, cache: { read: 100 } }, cost: 0.01 },
      },
      {
        type: 'step_finish',
        part: { tokens: { input: 2, output: 5, cache: { read: 200 } }, cost: 0.02 },
      },
    ],
    { tokensInput: 10, tokensOutput: 25, tokensCacheRead: 300, cost: 0.03 },
  ],
  [
    'codex',
    [
      {
        type: 'turn.completed',
        usage: { input_tokens: 100, output_tokens: 20, cached_input_tokens: 80 },
      },
      {
        type: 'turn.completed',
        usage: { input_tokens: 200, output_tokens: 25, cached_input_tokens: 180 },
      },
    ],
    { tokensInput: 200, tokensOutput: 25, tokensCacheRead: 180 },
  ],
  [
    'kiro',
    [
      { type: 'metadata', data: { meteringUsage: [{ value: 0.1, unit: 'credit' }] } },
      { type: 'metadata', data: { meteringUsage: [{ value: 0.2, unit: 'credit' }] } },
    ],
    { credits: expect.closeTo(0.3) },
  ],
];

describe('CLI usage recording', () => {
  it('retries a timed-out Kiro rate lookup and caches the recovered rate', async () => {
    vi.useFakeTimers();
    const store = { recordMetric: vi.fn(async () => ({ metricId: 'm1' })) };
    const spawnFn = vi.fn(() => {
      const child = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = vi.fn();
      if (spawnFn.mock.calls.length > 1) {
        setTimeout(() => {
          child.stderr.emit('data', Buffer.from('billed at $0.04 per credit'));
          child.emit('close', 0);
        }, 0);
      }
      return child;
    });
    const usage = createUsageRecorder({
      store,
      scope: { executionId: 'e', stageInstanceId: 's' },
      env: {},
      spawnFn,
    });

    for (const elapsedMs of [10_000, 0, 0]) {
      usage.onUsage({ credits: 0.1 });
      const recording = usage.flush();
      await vi.advanceTimersByTimeAsync(elapsedMs);
      await recording;
    }

    expect(store.recordMetric.mock.calls.map(([sample]) => sample.creditRate)).toEqual([
      null,
      0.04,
      0.04,
    ]);
    expect(spawnFn).toHaveBeenCalledTimes(2);
  });

  it.each(cases)(
    'records %s deltas once with scope and model attribution',
    async (cli, events, expected) => {
      const store = { recordMetric: vi.fn(async () => ({ metricId: 'm1' })) };
      const publish = vi.fn();
      const scope = { executionId: 'e', stageInstanceId: 's', unitSlug: 'u', sectionIndex: 2 };
      const usage = createUsageRecorder({
        store,
        scope,
        model: 'model',
        publish,
        env: {},
        spawnFn: () => ({
          on: (event, cb) => event === 'close' && setImmediate(() => cb(0)),
          stdin: { end() {} },
          stderr: {
            on: (event, cb) => event === 'data' && cb(Buffer.from('billed at $0.04 per credit')),
          },
        }),
      });
      const output = createCliOutputSink({ cli, emit: () => {}, onUsage: usage.onUsage });
      const stdout = events.map((event) => JSON.stringify(event)).join('\n');
      output.write(stdout);
      output.flush();
      await usage.flush();
      await usage.flush();
      expect(store.recordMetric).toHaveBeenCalledExactlyOnceWith({
        ...scope,
        resolvedModel: 'model',
        measured: true,
        metrics: expected,
        ...(cli === 'kiro' ? { creditRate: 0.04 } : {}),
      });
      expect(publish).toHaveBeenCalledExactlyOnceWith({
        action: 'agent.metric',
        ...scope,
        metricId: 'm1',
        metrics: expected,
      });
      if (cli === 'opencode') expect(parseOpenCodeJsonl(stdout).metrics).toEqual(expected);
      if (cli === 'codex') expect(parseCodexJsonl(stdout).metrics).toEqual(expected);
    },
  );
});

describe('usage by model', () => {
  it('records one sample per model, each priced as itself', async () => {
    const store = { recordMetric: vi.fn(async () => ({ metricId: 'm' })) };
    const usage = createUsageRecorder({
      store,
      scope: { executionId: 'e', stageInstanceId: 's' },
      model: 'eu.anthropic.claude-opus-5-5',
      env: {},
    });
    usage.onUsage({ tokensInput: 5 }, null, {
      model: 'eu.anthropic.claude-opus-5-5',
    });
    usage.onUsage({ tokensInput: 2 }, null, {
      model: 'eu.anthropic.claude-haiku-5-5',
    });
    usage.onUsage({ tokensOutput: 7 });
    await usage.flush();
    expect(store.recordMetric).toHaveBeenCalledTimes(2);
    expect(store.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedModel: 'eu.anthropic.claude-opus-5-5',
        metrics: { tokensInput: 5, tokensOutput: 7 },
      }),
    );
    expect(store.recordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        resolvedModel: 'eu.anthropic.claude-haiku-5-5',
        metrics: { tokensInput: 2 },
      }),
    );
    await usage.flush();
    expect(store.recordMetric).toHaveBeenCalledTimes(2);
  });

  it('marks every sample measured, and one from a partial delta incomplete', async () => {
    const store = { recordMetric: vi.fn(async () => ({ metricId: 'm' })) };
    const usage = createUsageRecorder({
      store,
      scope: { executionId: 'e', stageInstanceId: 's' },
      model: 'eu.anthropic.claude-opus-5-5',
      env: {},
    });
    usage.onUsage({ tokensInput: 4, tokensCacheRead: 900 }, null, { partial: true });
    await usage.flush();
    usage.onUsage({ tokensInput: 6 });
    await usage.flush();
    expect(store.recordMetric.mock.calls.map(([row]) => [row.measured, row.incomplete])).toEqual([
      [true, true],
      [true, undefined],
    ]);
  });
});

describe('a Claude session’s totals', () => {
  const OPUS = 'eu.anthropic.claude-opus-5-5';
  const HAIKU = 'eu.anthropic.claude-haiku-5-5';
  const setup = ({ fail = 0, sessionId = 'sess-1' } = {}) => {
    let failures = fail;
    let requests = 0;
    const store = {
      recordMetric: vi.fn(async () => ({ metricId: 'm' })),
      recordStageUsage: vi.fn(async ({ samples, requestId }) => {
        if (failures > 0) {
          failures -= 1;
          throw new Error('throttled');
        }
        return samples.map((sample, index) => ({ metricId: `${requestId}-${index}`, ...sample }));
      }),
    };
    const publish = vi.fn();
    const session = { totals: { [OPUS]: { tokensInput: 100 } }, known: true };
    const scope = { executionId: 'e', stageInstanceId: 's' };
    const usage = createUsageRecorder({
      store,
      scope,
      model: OPUS,
      publish,
      env: {},
      claudeSession: session,
      sessionId: () => sessionId,
      ids: () => `req-${(requests += 1)}`,
      now: () => new Date('2026-11-23T12:00:00.000Z'),
    });
    // What an output sink does on a result: report the spend, move the totals.
    const result = (totals, deltas) => {
      for (const [model, delta] of Object.entries(deltas)) usage.onUsage(delta, {}, { model });
      session.totals = totals;
      usage.onSessionTotals();
    };
    return { store, publish, session, scope, usage, result };
  };

  it('saves every model’s sample with the totals they account for, in one write', async () => {
    const { store, publish, scope, usage, result } = setup();
    result(
      { [OPUS]: { tokensInput: 105 }, [HAIKU]: { tokensInput: 2 } },
      { [OPUS]: { tokensInput: 5 }, [HAIKU]: { tokensInput: 2 } },
    );
    await usage.flush();
    expect(store.recordMetric).not.toHaveBeenCalled();
    expect(store.recordStageUsage).toHaveBeenCalledExactlyOnceWith({
      ...scope,
      samples: [
        { metrics: { tokensInput: 5 }, resolvedModel: OPUS, measured: true },
        { metrics: { tokensInput: 2 }, resolvedModel: HAIKU, measured: true },
      ],
      cliUsageTotals: {
        sessionId: 'sess-1',
        totals: { [OPUS]: { tokensInput: 105 }, [HAIKU]: { tokensInput: 2 } },
      },
      requestId: 'req-1',
      recordedAt: '2026-11-23T12:00:00.000Z',
    });
    expect(publish.mock.calls.map(([event]) => event.metricId)).toEqual(['req-1-0', 'req-1-1']);
  });

  const failure = (name, extra = {}) => Object.assign(new Error(name), { name, ...extra });

  it('tries a write that failed for a transient reason once more, as it was', async () => {
    const { store, usage, result } = setup({ fail: 1 });
    store.getStage = vi.fn(async () => ({ cliUsageTotals: null }));
    result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    expect(store.recordStageUsage).toHaveBeenCalledTimes(2);
    const [[first], [second]] = store.recordStageUsage.mock.calls;
    expect(second).toEqual(first);
    expect(store.recordMetric).not.toHaveBeenCalled();
  });

  it('counts a write that landed although it reported an error as saved, never twice', async () => {
    const { store, publish, usage, result } = setup({ fail: 1 });
    const sent = { sessionId: 'sess-1', totals: { [OPUS]: { tokensInput: 105 } } };
    store.getStage = vi.fn(async () => ({ cliUsageTotals: sent }));
    result(sent.totals, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    expect(store.getStage).toHaveBeenCalledWith('e', 's', { consistentRead: true });
    expect(store.recordStageUsage).toHaveBeenCalledOnce();
    expect(store.recordMetric).not.toHaveBeenCalled();
    expect(publish.mock.calls.map(([event]) => event.metricId)).toEqual(['req-1-0']);
    await usage.flush();
    expect(store.recordStageUsage).toHaveBeenCalledOnce();
  });

  it.each([
    [
      'the execution is no longer live',
      failure('ConditionalCheckFailedException', { code: 'run_fence' }),
    ],
    [
      'another attempt took over the stage with a fresh session',
      failure('ConditionalCheckFailedException', { code: 'stage_fence' }),
    ],
    ['the stage row is gone', failure('ConditionalCheckFailedException')],
    [
      'engine-data saw a different attempt',
      failure('EngineDataAccessDenied', { code: 'ownership_mismatch' }),
    ],
    ['the run was replaced', failure('EngineDataAccessDenied', { code: 'run_retired' })],
    [
      'engine-data does not know the op yet',
      failure('EngineDataAccessDenied', { code: 'op_not_allowed' }),
    ],
  ])('records the samples alone, without the totals, when %s', async (_label, error) => {
    const { store, session, usage, result } = setup();
    store.recordStageUsage.mockRejectedValue(error);
    store.getStage = vi.fn(async () => null);
    result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    expect(store.recordStageUsage).toHaveBeenCalledOnce();
    expect(store.recordMetric).toHaveBeenCalledExactlyOnceWith({
      executionId: 'e',
      stageInstanceId: 's',
      metrics: { tokensInput: 5 },
      resolvedModel: OPUS,
      measured: true,
    });
    expect(session.totals).toEqual({ [OPUS]: { tokensInput: 105 } });
  });

  it('sends a write that keeps failing again as it was, before the next one', async () => {
    const { store, usage, result } = setup({ fail: 2 });
    store.getStage = vi.fn(async () => ({ cliUsageTotals: null }));
    result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    expect(store.recordStageUsage).toHaveBeenCalledTimes(2);
    expect(store.recordMetric).not.toHaveBeenCalled();
    // A repair turn of the same session: the kept write goes first, unchanged.
    result({ [OPUS]: { tokensInput: 108 } }, { [OPUS]: { tokensInput: 3 } });
    await usage.flush();
    const [first, , kept, next] = store.recordStageUsage.mock.calls.map(([request]) => request);
    expect(kept).toEqual(first);
    expect(next).toMatchObject({
      requestId: 'req-2',
      samples: [{ metrics: { tokensInput: 3 }, resolvedModel: OPUS, measured: true }],
      cliUsageTotals: { sessionId: 'sess-1', totals: { [OPUS]: { tokensInput: 108 } } },
    });
  });

  it('keeps a write whose landing it cannot check, so a repeat that finds it isn’t counted', async () => {
    const { store, usage, result } = setup({ fail: 2 });
    store.getStage = vi.fn(async () => {
      throw new Error('read failed');
    });
    result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    await usage.flush();
    expect(
      new Set(store.recordStageUsage.mock.calls.map(([request]) => request.requestId)),
    ).toEqual(new Set(['req-1']));
    expect(store.recordMetric).not.toHaveBeenCalled();
  });

  it('records nothing when another attempt took over the stage and goes on with the session', async () => {
    const { store, usage, result } = setup();
    store.recordStageUsage.mockRejectedValue(
      failure('ConditionalCheckFailedException', { code: 'stage_fence' }),
    );
    store.getStage = vi.fn(async () => ({ cliSessionId: 'sess-1', cliUsageTotals: null }));
    result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    expect(store.recordStageUsage).toHaveBeenCalledOnce();
    expect(store.recordMetric).not.toHaveBeenCalled();
  });

  it('sends a newer write after a refused one', async () => {
    const { store, usage, result } = setup();
    store.getStage = vi.fn(async () => null);
    store.recordStageUsage
      .mockRejectedValueOnce(failure('Throttled'))
      .mockRejectedValueOnce(failure('Throttled'))
      .mockRejectedValueOnce(failure('ConditionalCheckFailedException', { code: 'run_fence' }));
    result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await usage.flush();
    result({ [OPUS]: { tokensInput: 108 } }, { [OPUS]: { tokensInput: 3 } });
    await usage.flush();
    expect(store.recordMetric).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ metrics: { tokensInput: 5 } }),
    );
    expect(store.recordStageUsage).toHaveBeenLastCalledWith(
      expect.objectContaining({
        requestId: 'req-2',
        samples: [expect.objectContaining({ metrics: { tokensInput: 3 } })],
      }),
    );
  });

  it('records samples one at a time when the totals did not change or the session has no id', async () => {
    const unchanged = setup();
    unchanged.usage.onUsage({ tokensInput: 5 }, {}, { model: OPUS });
    await unchanged.usage.flush();
    expect(unchanged.store.recordStageUsage).not.toHaveBeenCalled();
    expect(unchanged.store.recordMetric).toHaveBeenCalledOnce();

    const noSession = setup({ sessionId: null });
    noSession.result({ [OPUS]: { tokensInput: 105 } }, { [OPUS]: { tokensInput: 5 } });
    await noSession.usage.flush();
    expect(noSession.store.recordStageUsage).not.toHaveBeenCalled();
    expect(noSession.store.recordMetric).toHaveBeenCalledOnce();
  });
});
