import { act, renderHook, waitFor } from '@testing-library/react';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  resolveSession: vi.fn(),
  notifySessionExpired: vi.fn(),
  getRealtimeToken: vi.fn(),
  getYjsUrl: vi.fn(),
}));

vi.mock('../services/auth', () => ({
  authService: { resolveSession: mocks.resolveSession },
}));

vi.mock('../services/sessionExpiry', () => ({
  currentSessionEpoch: () => 7,
  notifySessionExpired: mocks.notifySessionExpired,
}));

vi.mock('../services/realtime', () => ({
  realtimeService: { getYjsUrl: mocks.getYjsUrl },
}));

vi.mock('../lib/realtimeToken', () => ({
  getRealtimeToken: mocks.getRealtimeToken,
  invalidateRealtimeToken: vi.fn(),
  msUntilRefresh: () => 60_000,
  scopeTargetForYjsDoc: () => ({ projectId: 'project-1' }),
}));

import { useCollaborativeArtifactContent } from './useCollaborativeArtifactContent';

class MockWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 3;

  readonly sent: Uint8Array[] = [];
  readyState = MockWebSocket.CONNECTING;
  binaryType: BinaryType = 'blob';
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  readonly url: string;

  constructor(url: string) {
    this.url = url;
    instances.push(this);
  }

  send(data: ArrayBuffer | ArrayBufferView) {
    this.sent.push(new Uint8Array(data as ArrayBuffer));
  }

  open() {
    this.readyState = MockWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  close(code = 1000, reason = '') {
    this.readyState = MockWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }
}

const instances: MockWebSocket[] = [];
const deliver = (ws: MockWebSocket, type: number, write: (encoder: encoding.Encoder) => void) => {
  const encoder = encoding.createEncoder();
  encoding.writeVarUint(encoder, type);
  write(encoder);
  ws.onmessage?.(new MessageEvent('message', { data: encoding.toUint8Array(encoder).buffer }));
};
const completeSync = (ws: MockWebSocket, doc: Y.Doc) =>
  deliver(ws, 0, (encoder) => syncProtocol.writeSyncStep2(encoder, doc));

describe('collaboration navigation saves', () => {
  beforeEach(() => {
    instances.length = 0;
    mocks.resolveSession
      .mockReset()
      .mockResolvedValue({ session: { idToken: 'id-token' }, expired: false });
    mocks.getRealtimeToken
      .mockReset()
      .mockResolvedValue({ token: 'scope-token', exp: Math.floor(Date.now() / 1000) + 600 });
    mocks.getYjsUrl.mockReset().mockReturnValue('wss://example.test/yjs/doc');
    vi.stubGlobal('WebSocket', MockWebSocket);
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(async () => {
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });
  const mount = async (
    save: (s: string) => Promise<void>,
    persistent = false,
    options: Pick<
      Parameters<typeof useCollaborativeArtifactContent>[0],
      'readSaveVersion' | 'onSaveError'
    > = {},
  ) => {
    const hook = renderHook(() =>
      useCollaborativeArtifactContent({
        projectId: 'project',
        intentId: 'intent',
        artifactId: 'artifact',
        userName: 'Alice',
        enabled: true,
        onAutoSave: save,
        ...options,
      }),
    );
    await waitFor(() => expect(instances).toHaveLength(1));
    const ws = instances[0];
    act(() => {
      ws.open();
      deliver(ws, 4, (e) => {
        encoding.writeVarUint(e, 0);
        encoding.writeVarUint(e, persistent ? 1 : 0);
      });
      const seed = new Y.Doc();
      completeSync(ws, seed);
      seed.destroy();
    });
    expect(hook.result.current.synced).toBe(true);
    return { ...hook, ws };
  };
  it('control: explicit standalone flush before unmount reaches REST', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const h = await mount(save);
    act(() => h.result.current.setContent('unsaved'));
    await act(() => h.result.current.flush());
    expect(save).toHaveBeenCalledWith('unsaved');
    h.unmount();
  });
  it('persists a pending standalone edit when navigating away', async () => {
    const save = vi.fn().mockResolvedValue(undefined);
    const h = await mount(save);
    act(() => h.result.current.setContent('unsaved'));
    h.unmount();
    await waitFor(() => expect(save).toHaveBeenCalledWith('unsaved'));
    expect(h.ws.readyState).toBe(MockWebSocket.CLOSED);
    expect(console.error).not.toHaveBeenCalled();
  });
  it('reports a failed revision preflight and retains the edit for retry', async () => {
    const error = new Error('Revision service unavailable');
    const readSaveVersion = vi.fn().mockRejectedValueOnce(error).mockResolvedValue('revision-1');
    const onSaveError = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);
    const h = await mount(save, false, { readSaveVersion, onSaveError });
    act(() => h.result.current.setContent('keep this edit'));
    await act(async () => {
      await expect(h.result.current.flush()).rejects.toBe(error);
    });
    expect(onSaveError).toHaveBeenCalledWith(error);
    expect(save).not.toHaveBeenCalled();
    expect(h.result.current.content).toBe('keep this edit');
    await act(() => h.result.current.flush());
    expect(save).toHaveBeenCalledWith('keep this edit', 'revision-1');
    h.unmount();
  });
  it('reports an interrupted checkpoint without writing the REST projection', async () => {
    const onSaveError = vi.fn();
    const save = vi.fn().mockResolvedValue(undefined);
    const h = await mount(save, true, { onSaveError });
    act(() => h.result.current.setContent('not yet durable'));
    const pending = h.result.current.flush();
    const rejected = expect(pending).rejects.toThrow();
    await waitFor(() =>
      expect(
        h.ws.sent.some((message) => {
          const decoder = decoding.createDecoder(message);
          return decoding.readVarUint(decoder) === 4 && decoding.readVarUint(decoder) === 1;
        }),
      ).toBe(true),
    );
    await act(async () => {
      h.ws.close(1012);
      await rejected;
    });
    expect(onSaveError).toHaveBeenCalledWith(expect.any(Error));
    expect(save).not.toHaveBeenCalled();
    h.unmount();
  });
  it('finishes the checkpoint and REST save before closing on navigation', async () => {
    let finish!: () => void;
    const save = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const h = await mount(save, true);
    act(() => h.result.current.setContent('keep this edit'));
    h.unmount();
    let request = 0;
    await waitFor(() => {
      for (const message of h.ws.sent) {
        const d = decoding.createDecoder(message);
        if (decoding.readVarUint(d) === 4 && decoding.readVarUint(d) === 1)
          request = decoding.readVarUint(d);
      }
      expect(request).toBeGreaterThan(0);
    });
    expect(h.ws.readyState).toBe(MockWebSocket.OPEN);
    expect(save).not.toHaveBeenCalled();
    act(() =>
      deliver(h.ws, 4, (e) => {
        encoding.writeVarUint(e, 2);
        encoding.writeVarUint(e, request);
      }),
    );
    await waitFor(() => expect(save).toHaveBeenCalledWith('keep this edit'));
    expect(h.ws.readyState).toBe(MockWebSocket.OPEN);
    await act(async () => finish());
    await waitFor(() => expect(h.ws.readyState).toBe(MockWebSocket.CLOSED));
  });
});
