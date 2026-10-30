import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildGatePending,
  gateNeed,
  gatePromptText,
  notifyGatePending,
  publishNotificationEvent,
  resetNotificationEventClient,
} from '../notification-events.js';

class FakePutEventsCommand {
  constructor(input) {
    this.input = input;
  }
}

const clientWith = (send) => async () => ({
  client: { send },
  PutEventsCommand: FakePutEventsCommand,
});

describe('publishNotificationEvent', () => {
  beforeEach(() => {
    resetNotificationEventClient();
    vi.stubEnv('NOTIFICATION_EVENT_BUS', 'bus-1');
    vi.stubEnv('NOTIFICATION_EVENT_SOURCE', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('does nothing, and never loads a client, without a bus', async () => {
    vi.stubEnv('NOTIFICATION_EVENT_BUS', '');
    const getClient = vi.fn();
    await expect(publishNotificationEvent('space.created', {}, { getClient })).resolves.toBe(false);
    expect(getClient).not.toHaveBeenCalled();
  });

  it('puts one entry on the bus with the default source', async () => {
    const send = vi.fn(async () => ({ FailedEntryCount: 0 }));
    const ok = await publishNotificationEvent(
      'discussion.message',
      { projectId: 'p', messageId: 'm' },
      { getClient: clientWith(send) },
    );
    expect(ok).toBe(true);
    const [command, options] = send.mock.calls[0];
    expect(command.input.Entries).toEqual([
      {
        EventBusName: 'bus-1',
        Source: 'collaborative-ai-dlc',
        DetailType: 'discussion.message',
        Detail: JSON.stringify({ schemaVersion: 1, projectId: 'p', messageId: 'm' }),
      },
    ]);
    expect(options.abortSignal).toBeInstanceOf(AbortSignal);
  });

  it('uses NOTIFICATION_EVENT_SOURCE when set', async () => {
    vi.stubEnv('NOTIFICATION_EVENT_SOURCE', 'acme.aidlc');
    const send = vi.fn(async () => ({ FailedEntryCount: 0 }));
    await publishNotificationEvent('gate.pending', {}, { getClient: clientWith(send) });
    expect(send.mock.calls[0][0].input.Entries[0].Source).toBe('acme.aidlc');
  });

  it('reports a rejected entry without throwing', async () => {
    const send = vi.fn(async () => ({
      FailedEntryCount: 1,
      Entries: [{ ErrorCode: 'AccessDeniedException' }],
    }));
    await expect(
      publishNotificationEvent('gate.pending', {}, { getClient: clientWith(send) }),
    ).resolves.toBe(false);
  });

  it('never throws when EventBridge fails', async () => {
    const send = vi.fn(async () => {
      throw Object.assign(new Error('down'), { name: 'ServiceUnavailable' });
    });
    await expect(
      publishNotificationEvent('space.created', {}, { getClient: clientWith(send) }),
    ).resolves.toBe(false);
  });

  it('never throws when the client cannot load', async () => {
    const getClient = vi.fn(async () => {
      throw new Error('module not found');
    });
    await expect(publishNotificationEvent('space.created', {}, { getClient })).resolves.toBe(false);
  });

  it('loads the real EventBridge client lazily', async () => {
    const { EventBridgeClient } = await import('@aws-sdk/client-eventbridge');
    const send = vi
      .spyOn(EventBridgeClient.prototype, 'send')
      .mockResolvedValue({ FailedEntryCount: 0 });
    await expect(publishNotificationEvent('space.created', { projectId: 'p' })).resolves.toBe(true);
    expect(send.mock.calls[0][0].input.Entries[0].EventBusName).toBe('bus-1');
    send.mockRestore();
  });
});

describe('gateNeed', () => {
  it('an agent question needs an answer', () => {
    expect(gateNeed({ kind: 'question' })).toBe('answer');
  });

  it('a checkpoint confirmation needs approval', () => {
    expect(gateNeed({ kind: 'question', detail: { checkpoint: 'plan' } })).toBe('approval');
  });

  it.each(['approval', 'validation', undefined])('%s needs approval', (kind) => {
    expect(gateNeed({ kind })).toBe('approval');
  });
});

describe('gatePromptText', () => {
  it('uses the prompt when there is one', () => {
    expect(gatePromptText({ prompt: '  Approve the design?  ' })).toBe('Approve the design?');
  });

  it('falls back to the first entry of the questions JSON', () => {
    const questions = JSON.stringify([{ text: 'Which database?' }, { text: 'Second' }]);
    expect(gatePromptText({ prompt: null, questions })).toBe('Which database?');
  });

  it('accepts a parsed array and question or plain-string entries', () => {
    expect(gatePromptText({ questions: [{ question: 'Q1' }] })).toBe('Q1');
    expect(gatePromptText({ questions: ['Plain'] })).toBe('Plain');
  });

  it('returns null for missing or malformed text, and clips to 1000 characters', () => {
    expect(gatePromptText({ questions: '{not json' })).toBeNull();
    expect(gatePromptText(null)).toBeNull();
    expect(gatePromptText({ prompt: 'x'.repeat(1500) })).toHaveLength(1000);
  });
});

describe('buildGatePending', () => {
  it('maps the gate row and execution META', () => {
    expect(
      buildGatePending({
        gate: { kind: 'question', questions: JSON.stringify([{ text: 'Which DB?' }]) },
        meta: { title: ` ${'t'.repeat(250)} `, startedBy: 'u1' },
        projectId: 'p1',
        intentId: 'i1',
        executionId: 'i1',
        humanTaskId: 'q-1',
        stage: 'requirements-analysis',
      }),
    ).toEqual({
      eventId: 'q-1',
      projectId: 'p1',
      intentId: 'i1',
      executionId: 'i1',
      humanTaskId: 'q-1',
      need: 'answer',
      kind: 'question',
      stage: 'requirements-analysis',
      intentTitle: 't'.repeat(200),
      startedBy: 'u1',
      prompt: 'Which DB?',
    });
  });

  it('tolerates a missing gate and META', () => {
    expect(buildGatePending({ humanTaskId: 'q-1' })).toMatchObject({
      need: 'approval',
      kind: null,
      stage: null,
      intentTitle: null,
      startedBy: null,
      prompt: null,
    });
  });
});

describe('notifyGatePending', () => {
  beforeEach(() => vi.stubEnv('NOTIFICATION_EVENT_BUS', 'bus-1'));
  afterEach(() => vi.unstubAllEnvs());

  const ids = { projectId: 'p1', intentId: 'i1', executionId: 'i1', humanTaskId: 'q-1' };
  const sent = (send) => JSON.parse(send.mock.calls[0][0].input.Entries[0].Detail);

  it('does nothing, and reads nothing, without a bus', async () => {
    vi.stubEnv('NOTIFICATION_EVENT_BUS', '');
    const store = { getHumanTask: vi.fn(), getExecution: vi.fn() };
    await expect(notifyGatePending(store, ids)).resolves.toBe(false);
    expect(store.getHumanTask).not.toHaveBeenCalled();
    expect(store.getExecution).not.toHaveBeenCalled();
  });

  it('reads the gate and META when not given them', async () => {
    const store = {
      getHumanTask: vi.fn(async () => ({ kind: 'question', questions: '[{"text":"Q?"}]' })),
      getExecution: vi.fn(async () => ({ title: 'Portal', startedBy: 'u1' })),
    };
    const send = vi.fn(async () => ({ FailedEntryCount: 0 }));
    await expect(
      notifyGatePending(store, { ...ids, stage: 's1' }, { getClient: clientWith(send) }),
    ).resolves.toBe(true);
    expect(store.getHumanTask).toHaveBeenCalledWith('i1', 'q-1');
    expect(sent(send)).toMatchObject({
      schemaVersion: 1,
      eventId: 'q-1',
      need: 'answer',
      stage: 's1',
      intentTitle: 'Portal',
      prompt: 'Q?',
    });
  });

  it('uses the gate and META it is given without reading them', async () => {
    const store = { getHumanTask: vi.fn(), getExecution: vi.fn() };
    const send = vi.fn(async () => ({ FailedEntryCount: 0 }));
    await notifyGatePending(
      store,
      { ...ids, gate: { kind: 'approval', prompt: 'Go?' }, meta: { title: 'T' } },
      { getClient: clientWith(send) },
    );
    expect(store.getHumanTask).not.toHaveBeenCalled();
    expect(store.getExecution).not.toHaveBeenCalled();
    expect(sent(send)).toMatchObject({ need: 'approval', prompt: 'Go?', intentTitle: 'T' });
  });

  it('still publishes, and never throws, when the store fails', async () => {
    const store = {
      getHumanTask: vi.fn(async () => {
        throw new Error('ddb down');
      }),
      getExecution: vi.fn(() => {
        throw new Error('sync failure');
      }),
    };
    const send = vi.fn(async () => ({ FailedEntryCount: 0 }));
    await expect(notifyGatePending(store, ids, { getClient: clientWith(send) })).resolves.toBe(
      true,
    );
    expect(sent(send)).toMatchObject({ humanTaskId: 'q-1', prompt: null });
  });

  const never = () => new Promise(() => {});

  it('drops a slow read and still publishes within the deadline', async () => {
    const enrich = new AbortController();
    const store = {
      getHumanTask: vi.fn(async () => ({ kind: 'question', questions: '["Q?"]' })),
      // Hangs; the read deadline passes shortly after the fast read lands.
      getExecution: vi.fn(() => {
        setTimeout(() => enrich.abort(), 10);
        return never();
      }),
    };
    const send = vi.fn(async () => ({ FailedEntryCount: 0 }));
    const pending = notifyGatePending(store, ids, {
      getClient: clientWith(send),
      enrichSignal: enrich.signal,
    });
    await expect(pending).resolves.toBe(true);
    expect(sent(send)).toMatchObject({ prompt: 'Q?', intentTitle: null, startedBy: null });
    expect(send.mock.calls[0][1].abortSignal.aborted).toBe(false);
  });

  it('gives up on reads and publish together at the overall deadline', async () => {
    const store = { getHumanTask: vi.fn(never), getExecution: vi.fn(never) };
    const send = vi.fn(never);
    const overall = new AbortController();
    const pending = notifyGatePending(store, ids, {
      getClient: clientWith(send),
      signal: overall.signal,
      enrichSignal: new AbortController().signal,
    });
    overall.abort();
    await expect(pending).resolves.toBe(false);
    expect(send).not.toHaveBeenCalled();
  });

  it('bounds the whole call by the default deadline', async () => {
    const store = { getHumanTask: vi.fn(never), getExecution: vi.fn(never) };
    const send = vi.fn(never);
    const started = Date.now();
    await expect(notifyGatePending(store, ids, { getClient: clientWith(send) })).resolves.toBe(
      false,
    );
    const elapsed = Date.now() - started;
    expect(send).toHaveBeenCalledTimes(1);
    expect(elapsed).toBeGreaterThanOrEqual(1900);
    expect(elapsed).toBeLessThan(2500);
  }, 5000);
});
