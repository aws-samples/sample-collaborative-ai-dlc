import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { publishNotificationEvent, resetNotificationEventClient } from '../notification-events.js';

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
        Detail: JSON.stringify({ projectId: 'p', messageId: 'm' }),
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
