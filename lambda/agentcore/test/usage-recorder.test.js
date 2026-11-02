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
