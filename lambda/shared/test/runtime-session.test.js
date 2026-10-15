import { describe, expect, it, vi } from 'vitest';
import {
  SESSION_ABSENT_ERRORS,
  SessionReleaseHandoffError,
  capacityProviderIdFromArn,
  releaseSession,
  releaseSessions,
  retryQueuedReleases,
  stopSession,
  stopSessions,
  withDisposableSession,
  DISPOSABLE_SESSION_GRACE_MS,
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
    // `notFound` is the lane-retry contract (v2-orchestrator/section.js).
    expect(await stopSession({ client: failing, target, sessionId: 's-1' })).toEqual({
      stopped: false,
      notFound: true,
      error: 'gone',
    });
    const throttled = { send: vi.fn().mockRejectedValue(named('ThrottlingException', 'slow')) };
    expect(await stopSession({ client: throttled, target, sessionId: 's-1' })).toEqual({
      stopped: false,
      notFound: false,
      error: 'slow',
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

  it('throws a hand-off error (caller keeps ownership) when the queue write also fails', async () => {
    const client = { send: vi.fn().mockRejectedValue(named('InternalServerException', 'boom')) };
    const cleanupStore = { enqueue: vi.fn().mockRejectedValue(new Error('ddb down')) };
    const failure = await releaseSession({
      client,
      capacityProviderArn: CP_ARN,
      sessionId: 's-1',
      cleanupStore,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(SessionReleaseHandoffError);
    expect(failure.sessionIds).toEqual(['s-1']);
  });

  it('throws a hand-off error when a failed delete has no store to hand off to', async () => {
    const client = { send: vi.fn().mockRejectedValue(named('InternalServerException', 'boom')) };
    await expect(
      releaseSession({ client, capacityProviderArn: CP_ARN, sessionId: 's-1' }),
    ).rejects.toBeInstanceOf(SessionReleaseHandoffError);
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

describe('withDisposableSession', () => {
  const NOW = Date.parse('2026-01-01T00:00:00.000Z');
  const queue = (overrides = {}) => {
    const log = [];
    return {
      log,
      enqueue: vi.fn().mockImplementation(async (record) => log.push(['enqueue', record])),
      remove: vi.fn().mockImplementation(async (id) => log.push(['remove', id])),
      listPending: vi.fn().mockResolvedValue([]),
      recordAttempt: vi.fn(),
      ...overrides,
    };
  };
  const tracingClient = (log, { deleteError } = {}) => ({
    send: vi.fn().mockImplementation(async (command) => {
      log.push([command.constructor.name, command.input]);
      if (command.constructor.name === 'DeleteCapacityProviderSessionCommand' && deleteError) {
        throw deleteError;
      }
      return {};
    }),
  });

  it('runs unchanged on microVM targets (no record, no release)', async () => {
    const cleanupStore = queue();
    const client = tracingClient([]);
    const use = vi.fn().mockResolvedValue('ok');
    const result = await withDisposableSession(
      { client, target: { agentRuntimeArn: 'arn:rt' }, cleanupStore, sessionId: 's-1' },
      use,
    );
    expect(result).toBe('ok');
    expect(use).toHaveBeenCalledWith('s-1');
    expect(cleanupStore.enqueue).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('owns the session before it is used, then releases it and drops the record', async () => {
    const cleanupStore = queue();
    const client = tracingClient(cleanupStore.log);
    const use = vi.fn().mockImplementation(async (id) => {
      cleanupStore.log.push(['use', id]);
      return 'probe-result';
    });
    const result = await withDisposableSession(
      { client, target, cleanupStore, source: 'verify-mcp', sessionId: 's-1', now: () => NOW },
      use,
    );
    expect(result).toBe('probe-result');
    expect(cleanupStore.log.map(([step]) => step)).toEqual([
      'enqueue',
      'use',
      'StopRuntimeSessionCommand',
      'DeleteCapacityProviderSessionCommand',
      'remove',
    ]);
    expect(cleanupStore.log[0][1]).toMatchObject({
      sessionId: 's-1',
      capacityProviderArn: CP_ARN,
      source: 'verify-mcp',
      notBefore: new Date(NOW + DISPOSABLE_SESSION_GRACE_MS).toISOString(),
    });
    expect(cleanupStore.log[3][1]).toEqual({ capacityProviderId: 'cp-123', sessionId: 's-1' });
    // The SDK never receives the capacity provider.
    expect(cleanupStore.log[2][1]).not.toHaveProperty('capacityProviderArn');
  });

  it('never invokes when ownership cannot be registered', async () => {
    const cleanupStore = queue({ enqueue: vi.fn().mockRejectedValue(new Error('table down')) });
    const client = tracingClient([]);
    const use = vi.fn();
    await expect(
      withDisposableSession({ client, target, cleanupStore, sessionId: 's-1' }, use),
    ).rejects.toThrow('table down');
    expect(use).not.toHaveBeenCalled();
    expect(client.send).not.toHaveBeenCalled();
  });

  it('refuses an Instances target with no cleanup store at all', async () => {
    const use = vi.fn();
    await expect(
      withDisposableSession({ client: tracingClient([]), target, sessionId: 's-1' }, use),
    ).rejects.toBeInstanceOf(SessionReleaseHandoffError);
    expect(use).not.toHaveBeenCalled();
  });

  it('still releases when the probe fails or its response is lost', async () => {
    const cleanupStore = queue();
    const client = tracingClient(cleanupStore.log);
    await expect(
      withDisposableSession({ client, target, cleanupStore, sessionId: 's-1' }, async () => {
        throw named('RuntimeClientError', 'socket hang up');
      }),
    ).rejects.toThrow('socket hang up');
    expect(sent(client, 'DeleteCapacityProviderSessionCommand')).toHaveLength(1);
    expect(cleanupStore.remove).toHaveBeenCalledWith('s-1');
  });

  it('leaves the record as the owner when the delete fails', async () => {
    const cleanupStore = queue();
    const client = tracingClient(cleanupStore.log, {
      deleteError: named('InternalServerException'),
    });
    await withDisposableSession(
      { client, target, cleanupStore, sessionId: 's-1' },
      async () => 'x',
    );
    expect(cleanupStore.enqueue).toHaveBeenCalledTimes(1);
    expect(cleanupStore.remove).not.toHaveBeenCalled();
  });

  it('treats an already-absent session as released', async () => {
    const cleanupStore = queue();
    const client = tracingClient([], { deleteError: named('ResourceNotFoundException') });
    await withDisposableSession(
      { client, target, cleanupStore, sessionId: 's-1' },
      async () => 'x',
    );
    expect(cleanupStore.remove).toHaveBeenCalledWith('s-1');
  });
});

describe('retryQueuedReleases with deferred records', () => {
  const NOW = Date.parse('2026-01-01T00:00:00.000Z');
  it('leaves a record alone until its grace window has passed, then deletes it', async () => {
    const record = {
      sessionId: 's-probe',
      capacityProviderArn: CP_ARN,
      notBefore: new Date(NOW + 60_000).toISOString(),
    };
    const cleanupStore = {
      listPending: vi.fn().mockResolvedValue([record]),
      remove: vi.fn(),
      recordAttempt: vi.fn(),
    };
    const client = { send: vi.fn().mockResolvedValue({}) };
    expect(await retryQueuedReleases({ client, cleanupStore, now: () => NOW })).toEqual([
      { sessionId: 's-probe', deferred: true },
    ]);
    expect(client.send).not.toHaveBeenCalled();
    expect(cleanupStore.remove).not.toHaveBeenCalled();

    await retryQueuedReleases({ client, cleanupStore, now: () => NOW + 120_000 });
    expect(sent(client, 'DeleteCapacityProviderSessionCommand')).toHaveLength(1);
    expect(cleanupStore.remove).toHaveBeenCalledWith('s-probe');
  });
});
