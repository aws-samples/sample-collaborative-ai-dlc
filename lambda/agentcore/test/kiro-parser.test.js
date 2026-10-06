import { describe, it, expect, vi } from 'vitest';
import { readFile } from 'node:fs/promises';
import { createKiroJsonlParser, parseKiroJsonl } from '../cli/kiro-parser.js';
import { createCliOutputSink } from '../output-normalizer.js';

// Event shapes below are taken from real `kiro-cli 2.27.1 chat --agent-engine v2
// --output-format stream-json` runs.
const line = (type, data) => `${JSON.stringify({ type, data })}\n`;
const update = (value) => line('sessionUpdate', { sessionId: 's-1', update: value });
const chunk = (text) =>
  update({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } });
const toolCall = (toolCallId, fields) =>
  update({ sessionUpdate: 'tool_call', toolCallId, ...fields });
const toolDone = (toolCallId, fields) =>
  update({ sessionUpdate: 'tool_call_update', toolCallId, status: 'completed', ...fields });
const metering = (...values) =>
  line('metadata', {
    sessionId: 's-1',
    meteringUsage: values.map((value) => ({ value, unit: 'credit', unitPlural: 'credits' })),
  });

describe('Kiro stream-json parser', () => {
  it('captures the session id, joins text chunks per message, and sums credits', () => {
    const onSession = vi.fn();
    const onUsage = vi.fn();
    const parser = createKiroJsonlParser({ onSession, onUsage });
    parser.write(line('runStarted', { payloadSchema: 'acp', engine: 'v2' }));
    parser.write(line('metadata', { sessionId: 's-1', contextUsagePercentage: 3.5 }));
    parser.write(chunk('Reading the') + chunk(' README.'));
    parser.write(
      toolCall('t1', {
        title: 'Reading README.md:1',
        kind: 'read',
        _meta: { kiro: { toolName: 'read' } },
      }),
    );
    parser.write(toolDone('t1', { rawOutput: { items: [{ Text: '# probe' }] } }));
    parser.write(chunk('Done.'));
    parser.write(metering(0.1, 0.05));
    parser.write(line('runFinished', { sessionId: 's-1', status: 'success', finalText: 'x' }));
    const state = parser.flush();

    expect(onSession).toHaveBeenCalledTimes(1);
    expect(onSession).toHaveBeenCalledWith('s-1');
    expect(state.sessionId).toBe('s-1');
    expect(state.text).toBe('Reading the README.\nDone.');
    expect(state.metrics.credits).toBeCloseTo(0.15);
    expect(onUsage).toHaveBeenCalledWith({ credits: expect.closeTo(0.15) }, expect.any(Object));
    expect(state.errors).toEqual([]);
  });

  it('accumulates credits across turns and ignores non-credit metering', () => {
    const state = parseKiroJsonl(
      metering(0.2) +
        metering(0.3) +
        line('metadata', { sessionId: 's-1', meteringUsage: [{ value: 9, unit: 'token' }] }),
    );
    expect(state.metrics.credits).toBeCloseTo(0.5);
  });

  it('reports no metrics when the run has no metering', () => {
    expect(parseKiroJsonl(line('metadata', { sessionId: 's-1' })).metrics).toBeNull();
  });

  it('pairs tool calls with their completion and maps native tools', () => {
    const tools = [];
    const parser = createKiroJsonlParser({ onTool: (tool) => tools.push(tool) });
    parser.write(
      toolCall('read', {
        title: 'Reading notes.txt:1',
        kind: 'read',
        locations: [{ path: '/w/notes.txt' }],
        _meta: { kiro: { toolName: 'read' } },
      }) +
        toolCall('create', {
          title: 'Creating out.txt',
          kind: 'edit',
          locations: [{ path: '/w/out.txt', line: 1 }],
          rawInput: { command: 'create', path: '/w/out.txt', content: 'hello' },
          _meta: { kiro: { toolName: 'write' } },
        }) +
        toolCall('replace', {
          title: 'Editing notes.txt',
          kind: 'edit',
          rawInput: { command: 'strReplace', path: '/w/notes.txt', oldStr: 'a', newStr: 'b' },
          _meta: { kiro: { toolName: 'write' } },
        }) +
        toolCall('shell', {
          title: 'Running: echo ok',
          kind: 'execute',
          rawInput: { command: 'echo ok' },
          _meta: { kiro: { toolName: 'shell' } },
        }),
    );
    expect(tools).toEqual([]); // nothing is reported until a call finishes
    parser.write(
      toolDone('read', { kind: 'read', rawOutput: { items: [{ Text: 'line one' }] } }) +
        toolDone('create', {
          kind: 'edit',
          rawOutput: { items: [{ Text: 'Successfully created' }] },
        }) +
        toolDone('replace', { kind: 'edit', rawOutput: { items: [{ Text: 'Replaced 1' }] } }) +
        // Shell output streams as an interim update without a status first.
        update({
          sessionUpdate: 'tool_call_update',
          toolCallId: 'shell',
          content: [{ type: 'content', content: { type: 'text', text: 'ok\n' } }],
        }) +
        toolDone('shell', {
          kind: 'execute',
          rawOutput: {
            items: [{ Json: { exit_status: 'exit status: 0', stdout: 'ok\n', stderr: '' } }],
          },
        }),
    );
    parser.flush();

    expect(tools.map(({ event: _event, ...tool }) => tool)).toEqual([
      expect.objectContaining({
        name: 'fs_read',
        status: 'completed',
        targets: ['/w/notes.txt'],
        output: 'line one',
      }),
      expect.objectContaining({
        name: 'edit',
        status: 'completed',
        targets: ['/w/out.txt'],
        editAction: 'Created',
      }),
      expect.objectContaining({ name: 'edit', targets: ['/w/notes.txt'], editAction: 'Updated' }),
      expect.objectContaining({
        name: 'shell',
        status: 'completed',
        input: 'echo ok',
        output: 'ok\n',
      }),
    ]);
  });

  it('reports MCP tools by bare name and marks isError results and failed shells as errors', () => {
    const tools = [];
    const parser = createKiroJsonlParser({ onTool: (tool) => tools.push(tool) });
    parser.write(
      toolCall('ok', {
        title: 'Running: @aidlc/echo_back',
        rawInput: { text: 'ping' },
        _meta: { kiro: { toolName: 'echo_back', mcpServerName: 'aidlc' } },
      }) +
        toolDone('ok', {
          kind: 'other',
          rawOutput: { items: [{ Json: { content: [{ type: 'text', text: 'echo:ping' }] } }] },
        }) +
        toolCall('bad', {
          title: 'Running: @aidlc/fail_tool',
          _meta: { kiro: { toolName: 'fail_tool', mcpServerName: 'aidlc' } },
        }) +
        // Kiro reports a failed MCP call as "completed" with isError in the envelope.
        toolDone('bad', {
          kind: 'other',
          rawOutput: {
            items: [
              { Json: { content: [{ type: 'text', text: 'deliberate failure' }], isError: true } },
            ],
          },
        }) +
        toolCall('exit1', {
          title: 'Running: false',
          kind: 'execute',
          rawInput: { command: 'false' },
        }) +
        toolDone('exit1', {
          rawOutput: {
            items: [{ Json: { exit_status: 'exit status: 1', stdout: '', stderr: 'boom' } }],
          },
        }) +
        toolCall('failed', { title: 'Reading x', kind: 'read' }) +
        toolDone('failed', { status: 'failed', rawOutput: { items: [{ Text: 'not found' }] } }),
    );
    parser.flush();

    expect(
      tools.map(({ name, server, status, output, error }) => ({
        name,
        server,
        status,
        output,
        error,
      })),
    ).toEqual([
      { name: 'echo_back', server: 'aidlc', status: 'completed', output: 'echo:ping', error: null },
      {
        name: 'fail_tool',
        server: 'aidlc',
        status: 'error',
        output: 'deliberate failure',
        error: 'deliberate failure',
      },
      { name: 'shell', server: null, status: 'error', output: 'boom', error: 'boom' },
      { name: 'fs_read', server: null, status: 'error', output: 'not found', error: 'not found' },
    ]);
  });

  it('reports runError events and unsuccessful run endings as errors', () => {
    const onError = vi.fn();
    const parser = createKiroJsonlParser({ onError });
    parser.write(
      line('runError', {
        sessionId: 's-1',
        stage: 'prompt',
        message:
          'Internal error (code -32603): Encountered an error in the response stream: The bearer token included in the request is invalid.',
      }),
    );
    parser.write(
      line('runFinished', { sessionId: 's-1', status: 'cancelled', stopReason: 'cancelled' }),
    );
    const state = parser.flush();
    expect(state.errors).toEqual([
      expect.stringContaining('The bearer token included in the request is invalid'),
      'Kiro run ended with status cancelled (cancelled)',
    ]);
    expect(onError).toHaveBeenCalledTimes(2);
  });

  it('reports a missing session from a failed resume without a session id', () => {
    const state = parseKiroJsonl(
      line('runStarted', { engine: 'v2' }) +
        line('runError', {
          sessionId: null,
          stage: 'init',
          message: 'Internal error: "Failed to start session: Session not found: s-gone"',
        }),
    );
    expect(state.sessionId).toBeNull();
    expect(state.errors).toEqual([expect.stringContaining('Session not found')]);
  });

  it('accepts arbitrarily split chunks and keeps non-JSON and unknown updates as diagnostics', () => {
    const onDiagnostic = vi.fn();
    const parser = createKiroJsonlParser({ onDiagnostic });
    const raw =
      'not json\n' +
      chunk('hel') +
      chunk('lo') +
      update({ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: 'hmm' } });
    for (const piece of raw.match(/[\s\S]{1,7}/g)) parser.write(piece);
    const state = parser.flush();
    expect(state.text).toBe('hello');
    expect(state.diagnostics).toEqual(['not json', expect.stringContaining('agent_thought_chunk')]);
    expect(onDiagnostic).toHaveBeenCalledTimes(2);
  });
});

describe('Kiro output sink', () => {
  const render = async () => {
    const emitted = [];
    const onSession = vi.fn();
    const onUsage = vi.fn();
    const sink = createCliOutputSink({
      cli: 'kiro',
      emit: (event) => emitted.push(event),
      onSession,
      onUsage,
    });
    const raw = await readFile(
      new URL('./fixtures/agent-output/kiro.jsonl', import.meta.url),
      'utf8',
    );
    sink.write(raw);
    const state = sink.flush();
    return { emitted, onSession, onUsage, state };
  };

  it('renders the stream as semantic transcript events', async () => {
    const { emitted } = await render();
    expect(emitted.map(({ display }) => [display.type, display.title ?? display.summary])).toEqual([
      ['message', 'Inspecting the settings template.'],
      ['batch_read', 'Read 2 workspace items: settings.html, settings.css'],
      ['message', 'The mobile pairing block needs an explicit empty state.'],
      ['edit', 'Updated: settings.html'],
      ['artifact', 'Created artifact: Settings mobile pairing'],
      ['tool', 'Shell failed'],
      ['message', 'Settings output verified across desktop and mobile layouts.'],
    ]);
    // send_output already persists through MCP, so it never renders twice.
    expect(emitted.some(({ content }) => content.includes('send_output'))).toBe(false);
    expect(emitted.find(({ display }) => display.type === 'tool').display).toMatchObject({
      level: 'error',
      details: expect.stringContaining('No such file or directory'),
    });
  });

  it('forwards the session id and credits to the runtime', async () => {
    const { onSession, onUsage, state } = await render();
    expect(onSession).toHaveBeenCalledWith('kiro-session-fixture');
    expect(onUsage).toHaveBeenCalledWith({ credits: expect.closeTo(0.28) }, expect.any(Object));
    expect(state.metrics.credits).toBeCloseTo(0.28);
  });

  it('labels stream errors as Kiro errors', () => {
    const emitted = [];
    const onError = vi.fn();
    const sink = createCliOutputSink({
      cli: 'kiro',
      emit: (event) => emitted.push(event),
      onError,
    });
    sink.write(
      line('runError', { sessionId: 's-1', stage: 'prompt', message: 'model unavailable' }),
    );
    sink.flush();
    expect(onError).toHaveBeenCalledWith('model unavailable', expect.any(Object));
    expect(emitted).toEqual([
      expect.objectContaining({
        display: expect.objectContaining({ type: 'raw', level: 'error', title: 'Kiro error' }),
      }),
    ]);
  });
});
