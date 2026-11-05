import { describe, it, expect, vi } from 'vitest';
import {
  cliErrorTail,
  createDiscussionAssistStart,
  resolveCliSelection,
} from '../commands/discussion-assist-start.js';

const basePayload = {
  command: 'discussion-assist-start',
  projectId: 'p1',
  intentId: 'i1',
  discussionId: 'd1',
  messageId: 'dm-12345678',
  requestId: 'assist-12345678',
  assistCommand: 'summarize',
};

describe('createDiscussionAssistStart', () => {
  it('validates the discussion assist identity and command', async () => {
    const start = createDiscussionAssistStart({ openGraph: vi.fn() });
    expect(await start({ ...basePayload, messageId: '' })).toMatchObject({
      ok: false,
      reason: 'missing_discussion_assist_identity',
    });
    expect(await start({ ...basePayload, assistCommand: 'invalid' })).toMatchObject({
      ok: false,
      reason: 'invalid_discussion_assist_command',
    });
  });

  it('accepts ask as a supported Quorum command', async () => {
    const openGraph = vi.fn(() => new Promise(() => {}));
    const start = createDiscussionAssistStart({ openGraph });
    const res = await start({ ...basePayload, assistCommand: 'ask', requestId: 'assist-ask' });
    expect(res).toMatchObject({ ok: true, accepted: true, requestId: 'assist-ask' });
  });

  it('accepts immediately and treats a duplicate request as idempotent while running', async () => {
    const openGraph = vi.fn(() => new Promise(() => {}));
    const start = createDiscussionAssistStart({ openGraph });

    const first = await start(basePayload);
    expect(first).toMatchObject({
      ok: true,
      accepted: true,
      requestId: 'assist-12345678',
      messageId: 'dm-12345678',
    });

    const duplicate = await start(basePayload);
    expect(duplicate).toMatchObject({
      ok: true,
      accepted: true,
      alreadyRunning: true,
      requestId: 'assist-12345678',
    });
    expect(openGraph).toHaveBeenCalledTimes(1);
  });

  it('uses the payload CLI for a DRAFT that already has snapshotted model settings', async () => {
    const result = await resolveCliSelection({
      store: {
        getExecution: async () => ({
          status: 'DRAFT',
          agentCli: null,
          cliModels: { kiro: 'kiro-model' },
        }),
      },
      g: null,
      projectId: 'p1',
      intentId: 'i1',
      requestedCli: 'kiro',
    });

    expect(result.requestedCli).toBe('kiro');
  });
});

// Native threads (task-2): advisory, verified-revision-only context.
describe('native discussion assist', () => {
  const ROOT = `native-discussions-${'d'.repeat(64)}`;
  const nativePayload = (artifact) => ({
    ...basePayload,
    intentId: ROOT,
    assistCommand: 'explain',
    instructions: 'Is the pipe gap fair?',
    requestedCli: 'kiro',
    nativeContext: { executionId: 'e1', artifact },
  });
  const artifact = {
    path: 'docs/plan.md',
    sha256: 'a'.repeat(64),
    publicationId: 'b'.repeat(64),
    publicationSequence: 2,
    mediaType: 'text/markdown',
    encoding: 'utf8',
    content: '# Plan\nPipe gap 120px\n',
    truncated: false,
  };
  // Records every traversal; answers only the reads the command performs.
  const fakeGraph = ({ discussion, messages = [] }) => {
    const traversals = [];
    const make = (steps) =>
      new Proxy(
        {},
        {
          get: (_target, name) => {
            if (name === 'then') return undefined;
            if (name === 'next' || name === 'toList') {
              return async () => {
                traversals.push(steps);
                const has = steps.filter(([step]) => step === 'has').map(([, args]) => args);
                if (name === 'toList')
                  return steps.some(([step, args]) => step === 'out' && args[0] === 'HAS_MESSAGE')
                    ? messages
                    : [];
                if (has.some(([label]) => label === 'Discussion'))
                  return { done: false, value: discussion };
                if (has.some(([label]) => label === 'DiscussionMessage')) {
                  return {
                    done: false,
                    value: { id: 'dm-12345678', content: 'done', assist_status: 'completed' },
                  };
                }
                return { done: true };
              };
            }
            return (...args) => make([...steps, [name, args]]);
          },
        },
      );
    return { g: { V: (...args) => make([['V', args]]) }, traversals };
  };
  const run = async (
    payload,
    discussion,
    {
      availableClis = ['kiro'],
      output = { ok: true, text: 'Looks fair.', metrics: { tokens: 1 } },
    } = {},
  ) => {
    const graph = fakeGraph({
      discussion: {
        id: 'd1',
        entity_type: 'artifact',
        entity_id: `nf-${'c'.repeat(64)}:${'a'.repeat(64)}`,
        entity_title: 'docs/plan.md',
        content_sha256: 'a'.repeat(64),
        ...discussion,
      },
      messages: [
        {
          id: 'dm-1',
          content: 'Too narrow?',
          author_name: 'Member',
          created_at: '2026-10-01T00:00:00Z',
        },
      ],
    });
    const store = {
      getExecution: vi.fn(async () => ({ status: 'RUNNING', agentCli: 'kiro', cliModels: {} })),
      getExecutionRecords: vi.fn(async () => ({ events: [] })),
      appendEvent: vi.fn(async () => {}),
      recordMetric: vi.fn(async () => {}),
    };
    const oneShot = vi.fn(async () => output);
    const materializeCliContextFn = vi.fn(async () => ({ agentName: 'aidlc' }));
    const broadcast = vi.fn();
    const broadcastNative = vi.fn();
    const busy = { enter: vi.fn(), leave: vi.fn() };
    // Records the workspace instead of creating it under the host /tmp.
    const mkdirFn = vi.fn(async () => undefined);
    const start = createDiscussionAssistStart({
      openGraph: async () => graph.g,
      acceptResult: async (result) => ({
        id: result.messageId,
        content: result.content,
        assistStatus: result.status,
      }),
      store,
      broadcast,
      broadcastNative,
      availableClis,
      oneShot,
      materializeCliContextFn,
      mkdirFn,
      busy,
      log: () => {},
    });
    const accepted = await start(payload);
    await vi.waitFor(() => expect(busy.leave).toHaveBeenCalled());
    return {
      accepted,
      graph,
      store,
      oneShot,
      materializeCliContextFn,
      mkdirFn,
      broadcast,
      broadcastNative,
    };
  };

  it('prompts with only the supplied revision and thread, without bridge tools or platform state', async () => {
    const r = await run(nativePayload(artifact));
    expect(r.accepted).toMatchObject({ ok: true, accepted: true });
    const { prompt } = r.oneShot.mock.calls[0][0];
    expect(prompt).toContain('Pipe gap 120px');
    expect(prompt).toContain('"sha256": "' + 'a'.repeat(64) + '"');
    expect(prompt).toContain('Too narrow?');
    expect(prompt).not.toContain('Compact intent map');
    expect(prompt).toContain('cannot approve');
    // No MCP graph/process bridge, no META or process records, no v2 events.
    expect(r.materializeCliContextFn.mock.calls[0][0].mcpEntry).toBeNull();
    expect(r.store.getExecution).not.toHaveBeenCalled();
    expect(r.store.getExecutionRecords).not.toHaveBeenCalled();
    expect(r.store.appendEvent).not.toHaveBeenCalled();
    expect(r.store.recordMetric).not.toHaveBeenCalled();
    // Every scoped read/write uses the native root property, never intent_id.
    const scoped = r.graph.traversals
      .flat()
      .filter(([step, args]) => step === 'has' && args.length === 2);
    expect(scoped).toContainEqual(['has', ['native_discussion_root', ROOT]]);
    expect(scoped.some(([, [key]]) => key === 'intent_id')).toBe(false);
    // Completion goes out on the protected native channel only.
    expect(r.broadcast).not.toHaveBeenCalled();
    expect(r.broadcastNative).toHaveBeenCalledWith(
      { projectId: 'p1', executionId: 'e1' },
      expect.objectContaining({ action: 'discussion.message', sprintId: ROOT, discussionId: 'd1' }),
    );
  });

  it.each([true, false])('records measured managed usage exactly once when ok=%s', async (ok) => {
    const metrics = { tokensInput: 100, tokensOutput: 20, credits: 0.5 };
    const r = await run(
      basePayload,
      { entity_type: 'intent', entity_id: 'i1' },
      {
        output: {
          ok,
          text: 'Measured answer',
          reason: 'cli_failed',
          metrics,
          model: 'selected-model',
          creditRate: 1.5,
        },
      },
    );
    expect(r.oneShot).toHaveBeenCalledTimes(1);
    expect(r.store.recordMetric).toHaveBeenCalledExactlyOnceWith({
      executionId: 'i1',
      stageInstanceId: null,
      metrics: { ...metrics, discussionAssistCalls: 1 },
      resolvedModel: 'selected-model',
      creditRate: 1.5,
    });
    expect(r.store.appendEvent).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        executionId: 'i1',
        type: ok ? 'v2.discussion_assist.completed' : 'v2.discussion_assist.failed',
      }),
    );
    expect(r.broadcastNative).not.toHaveBeenCalled();
  });

  it('keeps measured native failures out of managed metrics and events', async () => {
    const r = await run(nativePayload(artifact), undefined, {
      output: { ok: false, reason: 'cli_failed', metrics: { tokensInput: 100, tokensOutput: 20 } },
    });
    expect(r.oneShot).toHaveBeenCalledTimes(1);
    expect(r.store.recordMetric).not.toHaveBeenCalled();
    expect(r.store.appendEvent).not.toHaveBeenCalled();
    expect(r.broadcastNative).toHaveBeenCalledWith(
      { projectId: 'p1', executionId: 'e1' },
      expect.objectContaining({
        action: 'discussion.message',
        message: expect.objectContaining({ assistStatus: 'failed' }),
      }),
    );
  });

  it('creates the Quorum workspace before materializing codex context and spawning', async () => {
    // Codex's context lives in a separate home; nothing else creates the
    // working directory, and a missing cwd fails with exitCode null.
    const r = await run({ ...nativePayload(artifact), requestedCli: 'codex' }, undefined, {
      availableClis: ['codex'],
    });
    const [[cwd, options]] = r.mkdirFn.mock.calls;
    expect(cwd).toBe(`/tmp/quorum/${ROOT}/d1`);
    expect(options).toEqual({ recursive: true });
    expect(r.materializeCliContextFn.mock.calls[0][0]).toMatchObject({
      cli: 'codex',
      workspaceDir: cwd,
    });
    expect(r.oneShot.mock.calls[0][0].cwd).toBe(cwd);
    expect(r.mkdirFn.mock.invocationCallOrder[0]).toBeLessThan(
      r.materializeCliContextFn.mock.invocationCallOrder[0],
    );
    expect(r.mkdirFn.mock.invocationCallOrder[0]).toBeLessThan(
      r.oneShot.mock.invocationCallOrder[0],
    );
  });

  it('refuses context for a different revision than the thread discusses', async () => {
    const r = await run(nativePayload({ ...artifact, sha256: 'f'.repeat(64) }));
    expect(r.oneShot).not.toHaveBeenCalled();
    expect(r.broadcastNative).toHaveBeenCalledWith(
      { projectId: 'p1', executionId: 'e1' },
      expect.objectContaining({ action: 'discussion.message' }),
    );
  });

  it('names binary or oversized files without supplying bytes', async () => {
    const r = await run(nativePayload({ ...artifact, encoding: 'binary', content: null }));
    const { prompt } = r.oneShot.mock.calls[0][0];
    expect(prompt).toContain('Content not supplied (binary)');
  });

  it("uses the run's verified model for the run's CLI and leaves other CLIs to project settings", async () => {
    const withPin = await run({
      ...nativePayload(artifact),
      requestedCli: 'kiro',
      nativeContext: {
        executionId: 'e1',
        artifact,
        runModel: { cli: 'kiro', model: 'run-pinned-model' },
      },
    });
    expect(withPin.oneShot.mock.calls[0][0].cliModels).toMatchObject({ kiro: 'run-pinned-model' });
    const otherCli = await run({
      ...nativePayload(artifact),
      requestedCli: 'kiro',
      nativeContext: {
        executionId: 'e1',
        artifact,
        runModel: { cli: 'codex', model: 'openai.gpt-5.6-sol' },
      },
    });
    expect(otherCli.oneShot.mock.calls[0][0].cliModels?.kiro).toBeUndefined();
    for (const bad of [
      { cli: 'kiro', model: '' },
      { cli: 'unknown', model: 'x' },
      { cli: 'kiro', model: 'bad\nmodel' },
      null,
    ]) {
      const r = await run({
        ...nativePayload(artifact),
        requestedCli: 'kiro',
        nativeContext: { executionId: 'e1', artifact, runModel: bad },
      });
      expect(r.oneShot.mock.calls[0][0].cliModels?.kiro).toBeUndefined();
    }
  });

  it('rejects malformed native context and platform-shaped native roots before any work', async () => {
    const start = createDiscussionAssistStart({ openGraph: vi.fn() });
    expect(await start({ ...nativePayload(artifact), intentId: 'i1' })).toMatchObject({
      ok: false,
      reason: 'invalid_native_discussion_context',
    });
    expect(
      await start({ ...nativePayload(artifact), nativeContext: { executionId: '' } }),
    ).toMatchObject({ ok: false, reason: 'invalid_native_discussion_context' });
  });
});

describe('cliErrorTail', () => {
  it('keeps only redacted, bounded error lines and never ordinary output', () => {
    const sample = [
      '{"type":"item.completed","item":{"text":"the private answer body"}}',
      'ERROR: unexpected status 403 Forbidden: Bearer ABSKQmVkcm9ja0FQSUtleS1zZWNyZXQtdmFsdWU=',
      'model openai.gpt-5.6-sol not found for key eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.abcdefghijklmnopqrstuvwxyz0123',
    ].join('\n');
    const tail = cliErrorTail(sample);
    expect(tail).toContain('403 Forbidden');
    expect(tail).toContain('not found');
    expect(tail).not.toContain('private answer body');
    expect(tail).not.toMatch(/ABSK[A-Za-z0-9]/);
    expect(tail).not.toMatch(/eyJ[A-Za-z0-9]{10,}/);
    expect(cliErrorTail('all good')).toBeNull();
    expect(cliErrorTail('error '.repeat(200)).length).toBeLessThanOrEqual(300);
  });
});
