import { describe, it, expect, vi } from 'vitest';
import { createCodexJsonlParser, parseCodexJsonl } from '../cli/codex-parser.js';
import { createCliOutputSink } from '../output-normalizer.js';

const line = (value) => `${JSON.stringify(value)}\n`;

describe('Codex JSONL parser', () => {
  it('captures the thread id, agent-message text, and turn usage', () => {
    const parsed = parseCodexJsonl(
      [
        line({ type: 'thread.started', thread_id: 'thread_abc' }),
        line({ type: 'turn.started' }),
        line({
          type: 'item.completed',
          item: { id: 'i1', type: 'agent_message', text: 'hello ' },
        }),
        line({
          type: 'item.completed',
          item: { id: 'i2', type: 'agent_message', text: 'world' },
        }),
        line({
          type: 'turn.completed',
          usage: {
            input_tokens: 120,
            cached_input_tokens: 40,
            cache_write_input_tokens: 12,
            output_tokens: 30,
            reasoning_output_tokens: 7,
          },
        }),
      ].join(''),
    );
    expect(parsed).toMatchObject({
      text: 'hello world',
      sessionId: 'thread_abc',
      metrics: {
        tokensInput: 120,
        tokensOutput: 30,
        tokensReasoning: 7,
        tokensCacheRead: 40,
        tokensCacheWrite: 12,
      },
    });
    expect(parsed.errors).toEqual([]);
  });

  it('handles split chunks and malformed diagnostic lines without losing later events', () => {
    const onDiagnostic = vi.fn();
    const parser = createCodexJsonlParser({ onDiagnostic });
    const payload = line({
      type: 'item.completed',
      item: { type: 'agent_message', text: 'complete' },
    });
    parser.write('not json\n' + payload.slice(0, 17));
    parser.write(payload.slice(17));
    const state = parser.flush();
    expect(state.text).toBe('complete');
    expect(onDiagnostic).toHaveBeenCalledWith('not json');
  });

  it('maps completed command/mcp/file-change items to tool events; started items are silent', () => {
    const onTool = vi.fn();
    const parser = createCodexJsonlParser({ onTool });
    parser.write(
      [
        line({ type: 'item.started', item: { type: 'command_execution', command: 'ls' } }),
        line({
          type: 'item.completed',
          item: {
            type: 'command_execution',
            command: 'ls -la',
            aggregated_output: 'total 8',
            exit_code: 0,
          },
        }),
        line({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'aidlc',
            tool: 'get_artifact',
            status: 'completed',
            arguments: { id: 'a' },
          },
        }),
        line({
          type: 'item.completed',
          item: {
            type: 'file_change',
            status: 'completed',
            changes: [{ kind: 'update', path: 'src/app.js' }],
          },
        }),
      ].join(''),
    );
    parser.flush();
    expect(onTool).toHaveBeenCalledTimes(3);
    expect(onTool.mock.calls[0][0]).toMatchObject({
      name: 'shell',
      status: 'completed',
      input: 'ls -la',
      output: 'total 8',
    });
    expect(onTool.mock.calls[1][0]).toMatchObject({
      name: 'get_artifact',
      server: 'aidlc',
      status: 'completed',
    });
    expect(onTool.mock.calls[2][0]).toMatchObject({
      name: 'edit',
      status: 'completed',
      input: 'update src/app.js',
    });
  });

  it('marks failed commands and failed MCP calls as tool errors', () => {
    const onTool = vi.fn();
    const parser = createCodexJsonlParser({ onTool });
    parser.write(
      [
        line({
          type: 'item.completed',
          item: { type: 'command_execution', command: 'false', exit_code: 1 },
        }),
        line({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'aidlc',
            tool: 'create_artifact',
            status: 'failed',
          },
        }),
      ].join(''),
    );
    parser.flush();
    expect(onTool.mock.calls[0][0]).toMatchObject({ name: 'shell', status: 'error' });
    expect(onTool.mock.calls[1][0]).toMatchObject({ name: 'create_artifact', status: 'error' });
  });

  it('flattens the MCP result envelope to text and surfaces it on failures (live shape)', () => {
    const onTool = vi.fn();
    const parser = createCodexJsonlParser({ onTool });
    parser.write(
      [
        // Exact live shape: a failed call whose message rides in result.content,
        // with error null and structured_content null.
        line({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'aidlc',
            tool: 'ask_question',
            arguments: { questions: [{ text: 'Continue?' }] },
            result: {
              content: [{ type: 'text', text: 'Could not load credentials from any providers' }],
              structured_content: null,
            },
            error: null,
            status: 'failed',
          },
        }),
        line({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'aidlc',
            tool: 'get_artifact',
            status: 'completed',
            result: { content: [{ type: 'text', text: 'artifact body' }] },
          },
        }),
      ].join(''),
    );
    parser.flush();
    expect(onTool.mock.calls[0][0]).toMatchObject({
      name: 'ask_question',
      status: 'error',
      output: 'Could not load credentials from any providers',
      error: 'Could not load credentials from any providers',
    });
    expect(onTool.mock.calls[1][0]).toMatchObject({
      name: 'get_artifact',
      status: 'completed',
      output: 'artifact body',
    });
  });

  it('surfaces turn.failed and error events as actionable errors', () => {
    const onError = vi.fn();
    const parser = createCodexJsonlParser({ onError });
    parser.write(
      [
        line({ type: 'turn.failed', error: { message: 'model quota exceeded' } }),
        line({ type: 'error', message: 'stream aborted' }),
      ].join(''),
    );
    const state = parser.flush();
    expect(onError).toHaveBeenCalledWith('model quota exceeded', expect.any(Object));
    expect(state.errors).toEqual(['model quota exceeded', 'stream aborted']);
  });

  it('keeps reasoning and unknown item kinds as hidden diagnostics, not messages', () => {
    const onText = vi.fn();
    const onDiagnostic = vi.fn();
    const parser = createCodexJsonlParser({ onText, onDiagnostic });
    parser.write(
      [
        line({ type: 'item.completed', item: { type: 'reasoning', text: 'thinking…' } }),
        line({ type: 'item.completed', item: { type: 'plan_update', text: 'step 1 done' } }),
      ].join(''),
    );
    parser.flush();
    expect(onText).not.toHaveBeenCalled();
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });
});

describe('Codex output normalization', () => {
  it('suppresses send_output duplication while retaining text and tool failures', () => {
    const emitted = [];
    const sink = createCliOutputSink({ cli: 'codex', emit: (event) => emitted.push(event) });
    sink.write(
      [
        line({ type: 'item.completed', item: { type: 'agent_message', text: 'working' } }),
        line({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'aidlc',
            tool: 'send_output',
            status: 'completed',
            arguments: { content: 'canonical' },
          },
        }),
        line({
          type: 'item.completed',
          item: {
            type: 'mcp_tool_call',
            server: 'aidlc',
            tool: 'create_artifact',
            status: 'failed',
            arguments: { id: 'a' },
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

  it('captures the session id and usage through the sink callbacks', () => {
    const onSession = vi.fn();
    const onUsage = vi.fn();
    const sink = createCliOutputSink({ cli: 'codex', emit: () => {}, onSession, onUsage });
    sink.write(line({ type: 'thread.started', thread_id: 'thread_9' }));
    sink.write(line({ type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2 } }));
    sink.flush();
    expect(onSession).toHaveBeenCalledWith('thread_9');
    expect(onUsage).toHaveBeenCalledWith({ tokensInput: 5, tokensOutput: 2 }, expect.any(Object));
  });
});
