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
