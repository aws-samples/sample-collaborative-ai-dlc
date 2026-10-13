import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  notifySessionExpired: vi.fn(),
  getRealtimeToken: vi.fn(),
  invalidateRealtimeToken: vi.fn(),
  msUntilRefresh: vi.fn(),
}));

vi.mock('./auth', () => ({
  authService: { resolveSession: (...args: unknown[]) => mocks.resolveSession(...args) },
}));

vi.mock('./sessionExpiry', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./sessionExpiry')>();
  return {
    ...actual,
    notifySessionExpired: (epoch: number) => {
      mocks.notifySessionExpired(epoch);
      actual.notifySessionExpired(epoch);
    },
  };
});

import { currentSessionEpoch, resetSessionExpiry, notifySessionExpired } from './sessionExpiry';
import { clearPersistedCache } from '@/lib/persistentCache';

vi.mock('../lib/realtimeToken', () => ({
  getRealtimeToken: (...args: unknown[]) => mocks.getRealtimeToken(...args),
  invalidateRealtimeToken: (...args: unknown[]) => mocks.invalidateRealtimeToken(...args),
  msUntilRefresh: (...args: unknown[]) => mocks.msUntilRefresh(...args),
  scopeTargetForChannel: () => null,
}));

import { RealtimeService } from './realtime';

class MockWebSocket {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;
  static instances: MockWebSocket[] = [];

  readyState = MockWebSocket.CONNECTING;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: string[] = [];
  url: string;

  constructor(url: string) {
    this.url = url;
    MockWebSocket.instances.push(this);
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.();
  }

  serverClose() {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.();
  }

  close() {
    this.readyState = MockWebSocket.CLOSED;
  }

  send(message: string) {
    this.sent.push(message);
  }
}

const flushPromises = async () => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

describe('RealtimeService', () => {
  beforeEach(() => {
    resetSessionExpiry();
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    mocks.resolveSession
      .mockReset()
      .mockResolvedValue({ session: { idToken: 'id-token' }, expired: false });
    mocks.notifySessionExpired.mockReset();
    mocks.getRealtimeToken
      .mockReset()
      .mockResolvedValue({ token: 'scope-token', exp: 123, scopes: [] });
    mocks.invalidateRealtimeToken.mockReset();
    mocks.msUntilRefresh.mockReset().mockReturnValue(10_000);
  });

  afterEach(() => {
    resetSessionExpiry();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it.each(['logout', 'expiry', 'account'])(
    'detaches the old native channel on %s and ignores queued frames',
    async (boundary) => {
      const service = new RealtimeService(false);
      const target = { intentId: 'native', projectId: 'p', executionBackend: 'native' as const };
      const received = vi.fn();
      service.on('discussion.message', received);
      const connecting = service.connect('native-intent:p:native', target);
      await flushPromises();
      const ws = MockWebSocket.instances[0];
      ws.open();
      await connecting;
      const lateMessage = ws.onmessage!;
      if (boundary === 'logout') clearPersistedCache();
      else if (boundary === 'expiry') notifySessionExpired();
      else resetSessionExpiry();
      expect(ws.readyState).toBe(MockWebSocket.CLOSED);
      lateMessage({ data: JSON.stringify({ action: 'discussion.message', content: 'old-user' }) });
      await vi.advanceTimersByTimeAsync(30_000);
      expect(received).not.toHaveBeenCalled();
      expect(MockWebSocket.instances).toHaveLength(1);
      resetSessionExpiry();
      const next = service.connect('native-intent:p:native', target);
      await flushPromises();
      MockWebSocket.instances[1].open();
      await next;
      expect(service.getStatus()).toBe('connected');
      service.disconnect();
    },
  );

  it('discards a delayed token and does not open the previous account’s channel', async () => {
    let finish!: (value: unknown) => void;
    mocks.getRealtimeToken.mockReturnValueOnce(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const service = new RealtimeService(false);
    const pending = service.connect('native-intent:p:i', {
      intentId: 'i',
      projectId: 'p',
      executionBackend: 'native',
    });
    await flushPromises();
    resetSessionExpiry();
    finish({ token: 'old-member', exp: 123, scopes: [] });
    await pending;
    expect(MockWebSocket.instances).toHaveLength(0);
    expect(service.getStatus()).toBe('disconnected');
  });

  it('preserves the explicit intent scope target during token-refresh reconnect', async () => {
    const service = new RealtimeService(false);
    const target = { intentId: 'intent-1', projectId: 'project-1' };
    const connected = service.connect('intent:intent-1', target);
    await flushPromises();
    MockWebSocket.instances[0].open();
    await connected;

    await vi.advanceTimersByTimeAsync(10_000);
    await flushPromises();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(mocks.getRealtimeToken).toHaveBeenNthCalledWith(1, target);
    expect(mocks.getRealtimeToken).toHaveBeenNthCalledWith(2, target);
    expect(MockWebSocket.instances[1].url).toContain('documentId=intent%3Aintent-1');
  });

  it('notifies when Cognito reports definitive session expiry', async () => {
    const epoch = currentSessionEpoch();
    mocks.resolveSession.mockResolvedValue({ session: null, expired: true });
    const service = new RealtimeService(false);

    await expect(
      service.connect('intent:intent-1', {
        intentId: 'intent-1',
        projectId: 'project-1',
      }),
    ).rejects.toThrow('Not authenticated');

    expect(mocks.notifySessionExpired).toHaveBeenCalledWith(epoch);
  });

  it('reconnects an unexpectedly closed intent channel with the same target', async () => {
    const service = new RealtimeService(false);
    const target = { intentId: 'intent-1', projectId: 'project-1' };
    const connected = service.connect('intent:intent-1', target);
    await flushPromises();
    MockWebSocket.instances[0].open();
    await connected;

    MockWebSocket.instances[0].serverClose();
    await vi.advanceTimersByTimeAsync(1_000);
    await flushPromises();

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(mocks.getRealtimeToken).toHaveBeenLastCalledWith(target);
  });

  it('cancels an old channel retry when navigation requests a new channel', async () => {
    const service = new RealtimeService(false);
    const firstTarget = { intentId: 'intent-1', projectId: 'project-1' };
    const secondTarget = { intentId: 'intent-2', projectId: 'project-1' };
    const first = service.connect('intent:intent-1', firstTarget);
    await flushPromises();
    MockWebSocket.instances[0].open();
    await first;
    MockWebSocket.instances[0].serverClose();

    const second = service.connect('intent:intent-2', secondTarget);
    await flushPromises();
    MockWebSocket.instances[1].open();
    await second;
    await vi.advanceTimersByTimeAsync(1_000);

    expect(MockWebSocket.instances).toHaveLength(2);
    expect(MockWebSocket.instances[1].url).toContain('documentId=intent%3Aintent-2');
    service.disconnect('intent:intent-1');
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.OPEN);
    service.disconnect('intent:intent-2');
    expect(MockWebSocket.instances[1].readyState).toBe(MockWebSocket.CLOSED);
  });

  it('ignores malformed frames and isolates a failing message handler', async () => {
    const service = new RealtimeService(false);
    const received: string[] = [];
    service.on('agent.output', () => {
      throw new Error('bad handler');
    });
    service.on('agent.output', (data) => received.push(data.content));

    const connected = service.connect('intent:intent-1', {
      intentId: 'intent-1',
      projectId: 'project-1',
    });
    await flushPromises();
    const ws = MockWebSocket.instances[0];
    ws.open();
    await connected;

    ws.onmessage?.({ data: 'not-json' });
    ws.onmessage?.({ data: JSON.stringify({ action: 'agent.output', content: 'kept' }) });

    expect(received).toEqual(['kept']);
  });
});
