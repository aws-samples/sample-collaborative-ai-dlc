import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRealtimeToken: vi.fn(),
  invalidateRealtimeToken: vi.fn(),
  msUntilRefresh: vi.fn(),
}));

vi.mock('./auth', () => ({
  authService: { getSession: (...args: unknown[]) => mocks.getSession(...args) },
}));

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
    vi.useFakeTimers();
    MockWebSocket.instances = [];
    vi.stubGlobal('WebSocket', MockWebSocket);
    mocks.getSession.mockReset().mockResolvedValue({ idToken: 'id-token' });
    mocks.getRealtimeToken
      .mockReset()
      .mockResolvedValue({ token: 'scope-token', exp: 123, scopes: [] });
    mocks.invalidateRealtimeToken.mockReset();
    mocks.msUntilRefresh.mockReset().mockReturnValue(10_000);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
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
