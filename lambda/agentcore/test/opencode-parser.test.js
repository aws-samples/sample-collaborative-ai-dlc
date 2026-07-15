import { describe, it, expect, vi } from 'vitest';
import { createOpenCodeJsonlParser, parseOpenCodeJsonl } from '../cli/opencode-parser.js';
import { createCliOutputSink } from '../output-normalizer.js';

const line = (value) => `${JSON.stringify(value)}\n`;

describe('OpenCode JSONL parser', () => {
  it('captures completed text, the first session id, and native step usage', () => {
    const parsed = parseOpenCodeJsonl(
      [
        line({ type: 'step_start', sessionID: 'ses_first', part: { type: 'step-start' } }),
        line({
          type: 'text',
          sessionID: 'ses_second',
          part: { type: 'text', text: 'hello ' },
        }),
        line({ type: 'text', part: { type: 'text', text: 'world' } }),
        line({
          type: 'step_finish',
          part: {
            type: 'step-finish',
            cost: 0.012,
            tokens: {
              input: 120,
              output: 30,
              reasoning: 7,
              cache: { read: 40, write: 5 },
            },
          },
        }),
      ].join(''),
    );
    expect(parsed).toMatchObject({
      text: 'hello world',
      sessionId: 'ses_first',
      metrics: {
        tokensInput: 120,
        tokensOutput: 30,
        tokensReasoning: 7,
        tokensCacheRead: 40,
        tokensCacheWrite: 5,
        cost: 0.012,
      },
    });
  });

  it('handles split chunks and malformed diagnostic lines without losing later events', () => {
    const onDiagnostic = vi.fn();
    const parser = createOpenCodeJsonlParser({ onDiagnostic });
    const payload = line({
      type: 'text',
      sessionID: 'ses_1',
      part: { type: 'text', text: 'complete' },
    });
    parser.write('not json\n' + payload.slice(0, 13));
    parser.write(payload.slice(13));
    const state = parser.flush();
    expect(state.text).toBe('complete');
    expect(state.sessionId).toBe('ses_1');
    expect(onDiagnostic).toHaveBeenCalledWith('not json');
  });

  it('emits only completed/error tool calls and surfaces actionable errors', () => {
    const onTool = vi.fn();
    const onError = vi.fn();
    const parser = createOpenCodeJsonlParser({ onTool, onError });
    parser.write(
      [
        line({
          type: 'tool_use',
          part: { type: 'tool', tool: 'aidlc_get_artifact', state: { status: 'running' } },
        }),
        line({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'aidlc_get_artifact',
            state: { status: 'completed', input: { id: 'a' }, output: 'ok' },
          },
        }),
        line({ type: 'error', error: { data: { message: 'provider unavailable' } } }),
      ].join(''),
    );
    parser.flush();
    expect(onTool).toHaveBeenCalledOnce();
    expect(onTool.mock.calls[0][0]).toMatchObject({
      name: 'aidlc_get_artifact',
      status: 'completed',
    });
    expect(onError).toHaveBeenCalledWith('provider unavailable', expect.any(Object));
  });
});

describe('OpenCode output normalization', () => {
  it('suppresses send_output duplication while retaining text and tool failures', () => {
    const emitted = [];
    const sink = createCliOutputSink({ cli: 'opencode', emit: (event) => emitted.push(event) });
    sink.write(
      [
        line({ type: 'text', part: { type: 'text', text: 'working' } }),
        line({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'aidlc_send_output',
            state: { status: 'completed', input: { content: 'canonical' } },
          },
        }),
        line({
          type: 'tool_use',
          part: {
            type: 'tool',
            tool: 'aidlc_create_artifact',
            state: { status: 'error', input: { id: 'a' }, error: 'write failed' },
          },
        }),
      ].join(''),
    );
    sink.flush();
    expect(emitted.map((event) => event.content).join('')).not.toContain('canonical');
    expect(emitted[0]).toMatchObject({ content: 'working' });
    expect(emitted[1].display).toMatchObject({
      type: 'artifact',
      level: 'error',
      title: 'Artifact write failed: a',
    });
  });
});
