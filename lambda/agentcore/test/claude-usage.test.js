import { describe, it, expect, vi } from 'vitest';
import { claudeUsageMetrics } from '../cli/claude-usage.js';
import { createCliOutputSink } from '../output-normalizer.js';
import { parseClaudeOneShot } from '../cli/one-shot.js';

const usage = {
  input_tokens: 8,
  output_tokens: 1700,
  cache_read_input_tokens: 30000,
  cache_creation_input_tokens: 2000,
  cache_creation: { ephemeral_5m_input_tokens: 1500, ephemeral_1h_input_tokens: 500 },
};
const metrics = {
  tokensInput: 8,
  tokensOutput: 1700,
  tokensCacheRead: 30000,
  tokensCacheWrite: 2000,
  tokensCacheWrite1h: 500,
};

describe('Claude measured usage', () => {
  it('keeps uncached input and cache billing categories separate', () => {
    expect(claudeUsageMetrics(usage)).toEqual(metrics);
  });

  it('retains zero and omits missing, negative and non-numeric values', () => {
    expect(
      claudeUsageMetrics({
        input_tokens: 0,
        output_tokens: -1,
        cache_read_input_tokens: '100',
        cache_creation_input_tokens: Infinity,
      }),
    ).toEqual({ tokensInput: 0 });
    expect(claudeUsageMetrics(null)).toBeNull();
    expect(claudeUsageMetrics({})).toBeNull();
  });

  it.each([false, true])('records only terminal usage, including error results (%s)', (isError) => {
    const onUsage = vi.fn();
    const onError = vi.fn();
    const sink = createCliOutputSink({ cli: 'claude', emit: () => {}, onUsage, onError });
    const result = { type: 'result', is_error: isError, usage };
    const stream = [
      JSON.stringify({ type: 'assistant', message: { content: [], usage } }),
      JSON.stringify({
        type: 'stream_event',
        event: { type: 'message_start', message: { usage } },
      }),
      JSON.stringify(result),
    ].join('\r\n');
    for (let i = 0; i < stream.length; i += 7) sink.write(stream.slice(i, i + 7));
    expect(onUsage).not.toHaveBeenCalled();
    sink.flush();
    sink.flush();
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(metrics, result);
    expect(onError).toHaveBeenCalledTimes(isError ? 1 : 0);
  });

  it('uses the same cache counts for one-shot calls', () => {
    expect(
      parseClaudeOneShot(JSON.stringify({ type: 'result', result: 'Done', usage })),
    ).toMatchObject({
      text: 'Done',
      metrics,
    });
  });

  it('does not present the last assistant message usage as whole-invocation usage', () => {
    const stream = JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'partial' }], usage },
    });
    expect(parseClaudeOneShot(stream)).toMatchObject({ text: 'partial', metrics: null });
  });
});

describe('Claude whole-tree usage', () => {
  const MODEL = 'eu.anthropic.claude-opus-5-5';
  const SUBAGENT = 'eu.anthropic.claude-haiku-5-5';
  // Shapes as Claude Code reports them: `usage` covers the top-level loop only,
  // `modelUsage` the whole tree, and a resumed session's earlier spend too.
  const result = (modelUsage, mainUsage = usage) => ({
    type: 'result',
    subtype: 'success',
    usage: mainUsage,
    modelUsage,
  });
  const run = (lines, options = {}, flushOptions = undefined) => {
    const onUsage = vi.fn();
    const onSessionTotals = vi.fn();
    const sink = createCliOutputSink({
      cli: 'claude',
      emit: () => {},
      onUsage,
      onSessionTotals,
      ...options,
    });
    sink.write(`${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
    sink.flush(flushOptions);
    return { onUsage, onSessionTotals };
  };

  it('records each model in modelUsage, subagents included, not just the top-level loop', () => {
    const { onUsage, onSessionTotals } = run([
      result({
        [MODEL]: {
          inputTokens: 3519,
          outputTokens: 699213,
          cacheReadInputTokens: 219650016,
          cacheCreationInputTokens: 1849087,
        },
        [SUBAGENT]: {
          inputTokens: 10,
          outputTokens: 500,
          cacheReadInputTokens: 4000,
        },
      }),
    ]);
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith(
      {
        tokensInput: 3519,
        tokensOutput: 699213,
        tokensCacheRead: 219650016,
        tokensCacheWrite: 1849087,
        tokensCacheWrite1h: 500,
      },
      expect.anything(),
      { model: MODEL },
    );
    expect(onUsage).toHaveBeenCalledWith(
      { tokensInput: 10, tokensOutput: 500, tokensCacheRead: 4000 },
      expect.anything(),
      { model: SUBAGENT },
    );
    expect(onSessionTotals).toHaveBeenCalledOnce();
  });

  it('records only what a resumed session spent since its totals were last recorded', () => {
    const session = {
      totals: {
        [MODEL]: {
          tokensInput: 3519,
          tokensOutput: 699213,
          tokensCacheRead: 219650016,
          tokensCacheWrite: 1849087,
        },
      },
    };
    const { onUsage } = run(
      [
        result(
          {
            [MODEL]: {
              inputTokens: 3609,
              outputTokens: 761637,
              cacheReadInputTokens: 247359596,
              cacheCreationInputTokens: 1950213,
            },
          },
          {
            input_tokens: 90,
            cache_creation: { ephemeral_1h_input_tokens: 0 },
          },
        ),
      ],
      { claudeSession: session },
    );
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      {
        tokensInput: 90,
        tokensOutput: 62424,
        tokensCacheRead: 27709580,
        tokensCacheWrite: 101126,
      },
      expect.anything(),
      { model: MODEL },
    );
    expect(session.totals[MODEL].tokensCacheRead).toBe(247359596);
  });

  it('records a session that started again from zero as its own spend', () => {
    const session = {
      totals: { [MODEL]: { tokensInput: 500, tokensCacheRead: 9000 } },
    };
    const { onUsage } = run(
      [result({ [MODEL]: { inputTokens: 40, cacheReadInputTokens: 1000 } }, { input_tokens: 40 })],
      { claudeSession: session },
    );
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      { tokensInput: 40, tokensCacheRead: 1000 },
      expect.anything(),
      { model: MODEL },
    );
  });

  it('keeps the top-level loop’s 1-hour cache writes when one model ran', () => {
    const { onUsage } = run([
      result({ [MODEL]: { inputTokens: 8, cacheCreationInputTokens: 2400 } }),
    ]);
    expect(onUsage.mock.calls[0][0]).toMatchObject({
      tokensCacheWrite: 2400,
      tokensCacheWrite1h: 500,
    });
  });

  describe('1-hour cache writes when two models wrote to the cache', () => {
    const twoWriters = result({
      [MODEL]: { inputTokens: 8, cacheCreationInputTokens: 2400 },
      [SUBAGENT]: { inputTokens: 4, cacheCreationInputTokens: 900 },
    });
    const init = { type: 'system', subtype: 'init', model: MODEL };
    const byModel = (onUsage) =>
      Object.fromEntries(
        onUsage.mock.calls.map(([delta, , options]) => [options.model, [delta, options]]),
      );

    it('gives them to the main model the stream names, whatever the configured alias', () => {
      const { onUsage } = run([init, twoWriters], { claudeModel: 'opus' });
      const calls = byModel(onUsage);
      expect(calls[MODEL]).toEqual([
        { tokensInput: 8, tokensCacheWrite: 2400, tokensCacheWrite1h: 500 },
        { model: MODEL },
      ]);
      expect(calls[SUBAGENT]).toEqual([
        { tokensInput: 4, tokensCacheWrite: 900 },
        { model: SUBAGENT },
      ]);
    });

    it('gives them to the configured main model when the stream does not name one', () => {
      const { onUsage } = run([twoWriters], { claudeModel: MODEL });
      expect(byModel(onUsage)[MODEL][0].tokensCacheWrite1h).toBe(500);
    });

    it('marks the writers incomplete when the main model is not known', () => {
      const { onUsage } = run([twoWriters]);
      const calls = byModel(onUsage);
      expect(calls[MODEL]).toEqual([
        { tokensInput: 8, tokensCacheWrite: 2400 },
        { model: MODEL, partial: true },
      ]);
      expect(calls[SUBAGENT][1]).toEqual({ model: SUBAGENT, partial: true });
    });
  });

  describe('a resumed session with no saved totals', () => {
    const totals = {
      [MODEL]: { inputTokens: 500, outputTokens: 9000, cacheReadInputTokens: 80000 },
    };

    it('records this call’s top-level usage as incomplete, then counts from its totals', () => {
      const session = { totals: {}, known: false };
      const { onUsage, onSessionTotals } = run(
        [
          result(totals),
          result({
            [MODEL]: { inputTokens: 510, outputTokens: 9100, cacheReadInputTokens: 81000 },
          }),
        ],
        { claudeSession: session, claudeModel: MODEL },
      );
      expect(onUsage.mock.calls.map(([delta, , options]) => [delta, options])).toEqual([
        [metrics, { model: MODEL, partial: true }],
        [{ tokensInput: 10, tokensOutput: 100, tokensCacheRead: 1000 }, { model: MODEL }],
      ]);
      expect(session).toEqual({
        known: true,
        totals: { [MODEL]: { tokensInput: 510, tokensOutput: 9100, tokensCacheRead: 81000 } },
      });
      expect(onSessionTotals).toHaveBeenCalledTimes(2);
    });

    it('keeps the baseline unknown when the run ends without a result', () => {
      const session = { totals: {}, known: false };
      const step = {
        type: 'assistant',
        message: { id: 'msg_1', content: [], usage: { input_tokens: 20 } },
      };
      const { onUsage, onSessionTotals } = run(
        [step],
        { claudeSession: session, claudeModel: MODEL },
        { cliExited: true },
      );
      expect(onUsage).toHaveBeenCalledExactlyOnceWith({ tokensInput: 20 }, null, {
        model: MODEL,
        partial: true,
      });
      expect(onSessionTotals).not.toHaveBeenCalled();
      expect(session).toEqual({ totals: {}, known: false });
    });
  });

  it('falls back to the top-level steps’ input and cache tokens when a run ends without a usable result', () => {
    const step = (id, extra = {}) => ({
      type: 'assistant',
      message: {
        id,
        content: [],
        usage: {
          input_tokens: 2,
          output_tokens: 1,
          cache_read_input_tokens: 1000,
          ...extra,
        },
      },
    });
    const { onUsage } = run([
      step('msg_1'),
      step('msg_1'),
      step('msg_2', { cache_creation_input_tokens: 300 }),
      { ...step('msg_sub'), parent_tool_use_id: 'toolu_1' },
      result({}, { input_tokens: 0, output_tokens: 0 }),
    ]);
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      // Per-step output tokens are a placeholder, so they are left out.
      {
        tokensInput: 4,
        tokensCacheRead: 2000,
        tokensCacheWrite: 300,
      },
      null,
      { partial: true },
    );
  });

  it('records nothing twice when a result follows its steps', () => {
    const { onUsage } = run([
      {
        type: 'assistant',
        message: { id: 'msg_1', content: [], usage: { input_tokens: 5 } },
      },
      result({ [MODEL]: { inputTokens: 5 } }),
    ]);
    expect(onUsage).toHaveBeenCalledOnce();
  });

  it('keeps the baseline of a model a result leaves out', () => {
    const session = {
      totals: {
        [MODEL]: { tokensInput: 100, tokensCacheRead: 5000 },
        [SUBAGENT]: { tokensInput: 30, tokensCacheRead: 900 },
      },
    };
    run([result({ [MODEL]: { inputTokens: 120, cacheReadInputTokens: 6000 } })], {
      claudeSession: session,
    });
    expect(session.totals[SUBAGENT]).toEqual({ tokensInput: 30, tokensCacheRead: 900 });
    const { onUsage } = run(
      [
        result({
          [MODEL]: { inputTokens: 120, cacheReadInputTokens: 6000 },
          [SUBAGENT]: { inputTokens: 40, cacheReadInputTokens: 1000 },
        }),
      ],
      { claudeSession: session },
    );
    expect(onUsage).toHaveBeenCalledExactlyOnceWith(
      { tokensInput: 10, tokensCacheRead: 100 },
      expect.anything(),
      { model: SUBAGENT },
    );
  });

  it('starts the totals again when the session started again from zero', () => {
    const session = {
      totals: {
        [MODEL]: { tokensInput: 500, tokensCacheRead: 9000 },
        [SUBAGENT]: { tokensInput: 30 },
      },
    };
    run([result({ [MODEL]: { inputTokens: 40, cacheReadInputTokens: 1000 } })], {
      claudeSession: session,
    });
    expect(session.totals).toEqual({ [MODEL]: { tokensInput: 40, tokensCacheRead: 1000 } });
  });

  describe('a run that ends without a result, then a resume', () => {
    const steps = [
      {
        type: 'assistant',
        message: {
          id: 'msg_1',
          content: [],
          usage: { input_tokens: 20, output_tokens: 5, cache_read_input_tokens: 4000 },
        },
      },
    ];
    const baseline = () => ({
      totals: { [MODEL]: { tokensInput: 100, tokensOutput: 50, tokensCacheRead: 10000 } },
    });

    it('adds its steps to the baseline when the CLI exited, so the resume counts them once', () => {
      const session = baseline();
      const killed = run(
        steps,
        { claudeSession: session, claudeModel: MODEL },
        { cliExited: true },
      );
      expect(killed.onUsage).toHaveBeenCalledExactlyOnceWith(
        { tokensInput: 20, tokensCacheRead: 4000 },
        null,
        { model: MODEL, partial: true },
      );
      expect(killed.onSessionTotals).toHaveBeenCalledExactlyOnceWith({
        [MODEL]: { tokensInput: 120, tokensOutput: 50, tokensCacheRead: 14000 },
      });
      // Claude Code saved that run's spend (its real output, and a subagent's
      // input the steps can't see), so the resume reports it in modelUsage.
      const resumed = run(
        [
          result({
            [MODEL]: { inputTokens: 135, outputTokens: 90, cacheReadInputTokens: 16000 },
          }),
        ],
        { claudeSession: session, claudeModel: MODEL },
        { cliExited: true },
      );
      expect(resumed.onUsage).toHaveBeenCalledExactlyOnceWith(
        { tokensInput: 15, tokensOutput: 40, tokensCacheRead: 2000 },
        expect.anything(),
        { model: MODEL },
      );
    });

    it('leaves the baseline when the CLI was killed, which saves nothing', () => {
      const session = baseline();
      const { onSessionTotals } = run(
        steps,
        { claudeSession: session, claudeModel: MODEL },
        { cliExited: false },
      );
      expect(onSessionTotals).not.toHaveBeenCalled();
      expect(session.totals).toEqual(baseline().totals);
    });

    it('leaves the baseline when the main model is not known', () => {
      const session = baseline();
      run(steps, { claudeSession: session }, { cliExited: true });
      expect(session.totals).toEqual(baseline().totals);
    });
  });
});
