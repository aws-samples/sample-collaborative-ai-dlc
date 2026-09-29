import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_ABSENT_ERRORS,
  capacityProviderIdFromArn,
  releaseSession,
  releaseSessions,
  retryQueuedReleases,
  stopSession,
  stopSessions,
} from '../runtime-session.js';

const CP_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:capacity-provider/cp-123';
const target = {
  agentRuntimeArn: 'arn:rt',
  qualifier: 'revision_r_1',
  capacityProviderArn: CP_ARN,
};
const named = (name, message = name) => Object.assign(new Error(message), { name });
const sent = (client, name) =>
  client.send.mock.calls.map((c) => c[0]).filter((c) => c.constructor.name === name);

describe('capacityProviderIdFromArn', () => {
  it('extracts the id and tolerates junk', () => {
    expect(capacityProviderIdFromArn(CP_ARN)).toBe('cp-123');
    expect(capacityProviderIdFromArn(null)).toBeNull();
    expect(capacityProviderIdFromArn('')).toBeNull();
  });
});

describe('stopSession', () => {
  it('stops with the runtime target and never throws', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    expect(await stopSession({ client, target, sessionId: 's-1' })).toEqual({ stopped: true });
    expect(client.send.mock.calls[0][0].input).toEqual({
      agentRuntimeArn: 'arn:rt',
      qualifier: 'revision_r_1',
      runtimeSessionId: 's-1',
    });
    const failing = { send: vi.fn().mockRejectedValue(named('ResourceNotFoundException', 'gone')) };
    expect(await stopSession({ client: failing, target, sessionId: 's-1' })).toEqual({
      stopped: false,
      error: 'gone',
    });
  });

  it('skips when there is no client, target or session', async () => {
    expect(await stopSession({ client: null, target, sessionId: 's-1' })).toMatchObject({
      skipped: true,
    });
    expect(
      await stopSession({ client: { send: vi.fn() }, target: {}, sessionId: 's-1' }),
    ).toMatchObject({ skipped: true });
  });

  it('stopSessions deduplicates', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    await stopSessions({ client, target, sessionIds: ['a', 'b', 'a'] });
    expect(client.send).toHaveBeenCalledTimes(2);
  });
});

describe('releaseSession', () => {
  it('deletes the capacity-provider session', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    expect(await releaseSession({ client, capacityProviderArn: CP_ARN, sessionId: 's-1' })).toEqual(
      {
        released: true,
      },
    );
    expect(client.send.mock.calls[0][0].constructor.name).toBe(
      'DeleteCapacityProviderSessionCommand',
    );
    expect(client.send.mock.calls[0][0].input).toEqual({
      capacityProviderId: 'cp-123',
      sessionId: 's-1',
    });
  });

  it('treats a confirmed-absent session as released', async () => {
    for (const name of SESSION_ABSENT_ERRORS) {
      const client = { send: vi.fn().mockRejectedValue(named(name)) };
      expect(
        await releaseSession({ client, capacityProviderArn: CP_ARN, sessionId: 's-1' }),
      ).toEqual({
        released: true,
        absent: true,
      });
    }
  });

  it('is a no-op without a capacity provider (microVMs)', async () => {
    const client = { send: vi.fn() };
    expect(await releaseSession({ client, capacityProviderArn: null, sessionId: 's-1' })).toEqual({
      released: false,
      skipped: true,
    });
    expect(client.send).not.toHaveBeenCalled();
  });

  it('queues any other failure on the cleanup store instead of throwing', async () => {
    const client = { send: vi.fn().mockRejectedValue(named('InternalServerException', 'boom')) };
    const cleanupStore = { enqueue: vi.fn().mockResolvedValue({}) };
    const outcome = await releaseSession({
      client,
      capacityProviderArn: CP_ARN,
      sessionId: 's-1',
      cleanupStore,
      source: 'test',
      context: { intentId: 'i-1' },
    });
    expect(outcome).toEqual({ released: false, queued: true, reason: 'boom' });
    expect(cleanupStore.enqueue).toHaveBeenCalledWith({
      sessionId: 's-1',
      capacityProviderArn: CP_ARN,
      source: 'test',
      reason: 'boom',
      context: { intentId: 'i-1' },
    });
  });

  it('reports the double failure when the queue write also fails', async () => {
    const client = { send: vi.fn().mockRejectedValue(named('InternalServerException', 'boom')) };
    const cleanupStore = { enqueue: vi.fn().mockRejectedValue(new Error('ddb down')) };
    expect(
      await releaseSession({ client, capacityProviderArn: CP_ARN, sessionId: 's-1', cleanupStore }),
    ).toEqual({ released: false, queued: false, reason: 'boom' });
  });
});

describe('releaseSessions', () => {
  it('stops then releases every session, deduplicated', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    const results = await releaseSessions({ client, target, sessionIds: ['a', 'b', 'a'] });
    expect(sent(client, 'StopRuntimeSessionCommand').map((c) => c.input.runtimeSessionId)).toEqual([
      'a',
      'b',
    ]);
    expect(
      sent(client, 'DeleteCapacityProviderSessionCommand').map((c) => c.input.sessionId),
    ).toEqual(['a', 'b']);
    expect(results).toEqual([
      { sessionId: 'a', released: true },
      { sessionId: 'b', released: true },
    ]);
  });

  it('only stops when the target has no capacity provider', async () => {
    const client = { send: vi.fn().mockResolvedValue({}) };
    const results = await releaseSessions({
      client,
      target: { agentRuntimeArn: 'arn:rt' },
      sessionIds: ['a'],
    });
    expect(sent(client, 'StopRuntimeSessionCommand')).toHaveLength(1);
    expect(sent(client, 'DeleteCapacityProviderSessionCommand')).toHaveLength(0);
    expect(results).toEqual([{ sessionId: 'a', skipped: true }]);
  });
});

describe('retryQueuedReleases', () => {
  const record = { sessionId: 's-1', capacityProviderArn: CP_ARN, attempts: 2 };
  const storeWith = (pending) => ({
    listPending: vi.fn().mockResolvedValue(pending),
    remove: vi.fn().mockResolvedValue(undefined),
    recordAttempt: vi.fn().mockResolvedValue({}),
    enqueue: vi.fn(),
  });

  it('removes the record after a successful delete', async () => {
    const cleanupStore = storeWith([record]);
    const client = { send: vi.fn().mockResolvedValue({}) };
    expect(await retryQueuedReleases({ client, cleanupStore })).toEqual([
      { sessionId: 's-1', cleaned: true },
    ]);
    expect(cleanupStore.remove).toHaveBeenCalledWith('s-1');
    expect(cleanupStore.enqueue).not.toHaveBeenCalled();
  });

  it('keeps the record and bumps attempts on another failure', async () => {
    const cleanupStore = storeWith([record]);
    const client = { send: vi.fn().mockRejectedValue(named('ThrottlingException', 'slow down')) };
    expect(await retryQueuedReleases({ client, cleanupStore })).toEqual([
      { sessionId: 's-1', cleaned: false },
    ]);
    expect(cleanupStore.remove).not.toHaveBeenCalled();
    expect(cleanupStore.recordAttempt).toHaveBeenCalledWith('s-1', 'slow down');
    // A retry never re-enqueues (that would reset attempts to 0).
    expect(cleanupStore.enqueue).not.toHaveBeenCalled();
  });

  it('drops unactionable records', async () => {
    const cleanupStore = storeWith([{ sessionId: 'orphan', capacityProviderArn: null }]);
    const client = { send: vi.fn() };
    expect(await retryQueuedReleases({ client, cleanupStore })).toEqual([
      { sessionId: 'orphan', dropped: true },
    ]);
    expect(client.send).not.toHaveBeenCalled();
  });
});
