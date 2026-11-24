import { describe, it, expect, vi } from 'vitest';
import {
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

  it('records the assist’s CLI-reported usage as measured, with no stage', async () => {
    const recordMetric = vi.fn(async () => ({}));
    const completed = Promise.withResolvers();
    const ops = {
      readProjectCliConfig: async () => ({ agentCli: 'claude', cliModels: null, tierModels: null }),
      readDiscussionContext: async () => ({
        discussion: { entity_type: 'artifact', entity_id: 'a-1', status: 'open' },
        selected: [],
        recent: [],
        anchor: null,
        intentMap: {},
      }),
      completeDiscussionAssist: async (input) => {
        completed.resolve(input);
        return { id: input.messageId, assistStatus: input.status, content: input.content };
      },
      close: async () => {},
    };
    const start = createDiscussionAssistStart({
      openEngineGraph: async () => ops,
      engineData: false,
      store: { recordMetric },
      availableClis: ['claude'],
      materializeCliContextFn: async () => ({}),
      oneShot: async () => ({
        ok: true,
        text: 'answer',
        cli: 'claude',
        model: 'm1',
        metrics: { tokensInput: 9 },
      }),
      env: {},
      log: () => {},
    });
    expect(await start(basePayload)).toMatchObject({ ok: true, accepted: true });
    await completed.promise;
    await vi.waitFor(() => expect(recordMetric).toHaveBeenCalled());
    expect(recordMetric).toHaveBeenCalledExactlyOnceWith({
      executionId: 'i1',
      stageInstanceId: null,
      metrics: { tokensInput: 9, discussionAssistCalls: 1 },
      resolvedModel: 'm1',
      creditRate: null,
      measured: true,
    });
  });
});
