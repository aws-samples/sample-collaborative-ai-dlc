import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import * as syncProtocol from 'y-protocols/sync';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
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

import { useYjsDocument } from './useYjsDocument';

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

describe('useYjsDocument', () => {
  beforeEach(() => {
    instances.length = 0;
    mocks.resolveSession
      .mockReset()
      .mockResolvedValue({ session: { idToken: 'id-token' }, expired: false });
    mocks.notifySessionExpired.mockReset();
    mocks.getRealtimeToken
      .mockReset()
      .mockResolvedValue({ token: 'scope-token', exp: Math.floor(Date.now() / 1000) + 600 });
    mocks.getYjsUrl.mockReset().mockReturnValue('wss://example.test/yjs/doc');
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(async () => {
    if (vi.isFakeTimers()) await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('publishes the current user awareness state as soon as the socket opens', async () => {
    const { result, unmount } = renderHook(
      () => useYjsDocument('inception-project-1', 'Alice', '#3b82f6'),
      {
        wrapper: ({ children }: { children: ReactNode }) => <StrictMode>{children}</StrictMode>,
      },
    );

    await waitFor(() => expect(instances).toHaveLength(1));
    act(() => instances[0].open());

    expect(instances[0].sent).toHaveLength(2);
    const decoder = decoding.createDecoder(instances[0].sent[1]);
    expect(decoding.readVarUint(decoder)).toBe(1);

    const mirrorDoc = new Y.Doc();
    const mirrorAwareness = new awarenessProtocol.Awareness(mirrorDoc);
    awarenessProtocol.applyAwarenessUpdate(
      mirrorAwareness,
      decoding.readVarUint8Array(decoder),
      'test',
    );

    expect(mirrorAwareness.getStates().get(result.current.doc.clientID)?.user).toEqual({
      name: 'Alice',
      color: '#3b82f6',
      colorLight: '#3b82f633',
    });

    unmount();
    mirrorAwareness.destroy();
    mirrorDoc.destroy();
  });

  it('notifies when Cognito reports definitive session expiry', async () => {
    mocks.resolveSession.mockResolvedValue({ session: null, expired: true });

    const { unmount } = renderHook(() => useYjsDocument('inception-project-1', 'Alice'));

    await waitFor(() => expect(mocks.notifySessionExpired).toHaveBeenCalledWith(7));
    expect(instances).toHaveLength(0);
    unmount();
  });

  it('counts only local edits and does not echo remote presence', async () => {
    const { result, unmount } = renderHook(() => useYjsDocument('inception-project-1', 'Alice'));
    await waitFor(() => expect(instances).toHaveLength(1));
    const ws = instances[0];
    act(() => ws.open());
    const peer = new Y.Doc();
    peer.getText('content').insert(0, 'seed');
    act(() => completeSync(ws, peer));
    expect(result.current.synced).toBe(true);
    expect(result.current.localRevision).toBe(0);
    act(() => result.current.doc.getText('content').insert(0, 'local'));
    expect(result.current.localRevision).toBe(1);
    const peerAwareness = new awarenessProtocol.Awareness(peer);
    peerAwareness.setLocalStateField('user', { name: 'Bob' });
    // Wait for our coalesced initial awareness before measuring remote echoes.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    const before = ws.sent.length;
    act(() =>
      deliver(ws, 1, (encoder) =>
        encoding.writeVarUint8Array(
          encoder,
          awarenessProtocol.encodeAwarenessUpdate(peerAwareness, [peer.clientID]),
        ),
      ),
    );
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    expect(result.current.remoteUsers.get(peer.clientID)?.name).toBe('Bob');
    expect(ws.sent).toHaveLength(before);
    unmount();
    peerAwareness.destroy();
    peer.destroy();
  });

  it('sends unchanged-state awareness renewals without periodic document sync', async () => {
    const { result, unmount } = renderHook(() => useYjsDocument('inception-project-1', 'Alice'));
    await waitFor(() => expect(instances).toHaveLength(1));
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
    vi.useFakeTimers();
    const ws = instances[0];
    act(() => ws.open());
    const before = ws.sent.filter((bytes) => bytes[0] === 0).length;
    const presenceBefore = ws.sent.filter((bytes) => bytes[0] === 1).length;
    act(() => result.current.awareness.setLocalState(result.current.awareness.getLocalState()));
    await act(() => vi.advanceTimersByTimeAsync(30_001));
    expect(ws.sent.filter((bytes) => bytes[0] === 1).length).toBeGreaterThan(presenceBefore);
    expect(ws.sent.filter((bytes) => bytes[0] === 0)).toHaveLength(before);
    unmount();
  });

  it('waits for the checkpoint receipt and rejects an interrupted flush', async () => {
    const { result, unmount } = renderHook(() => useYjsDocument('inception-project-1', 'Alice'));
    await waitFor(() => expect(instances).toHaveLength(1));
    const ws = instances[0];
    act(() => ws.open());
    await expect(result.current.flushDocument()).rejects.toThrow('not synchronized');
    act(() => {
      deliver(ws, 4, (encoder) => {
        encoding.writeVarUint(encoder, 0);
        encoding.writeVarUint(encoder, 1);
      });
      completeSync(ws, new Y.Doc());
    });
    let completed = false;
    const flush = result.current.flushDocument().then(() => {
      completed = true;
    });
    await act(async () => {
      await Promise.resolve();
    });
    const request = decoding.createDecoder(ws.sent.at(-1)!);
    expect(decoding.readVarUint(request)).toBe(4);
    expect(decoding.readVarUint(request)).toBe(1);
    const id = decoding.readVarUint(request);
    expect(completed).toBe(false);
    await act(async () => {
      deliver(ws, 4, (encoder) => {
        encoding.writeVarUint(encoder, 2);
        encoding.writeVarUint(encoder, id);
      });
      await flush;
    });
    expect(completed).toBe(true);
    const sentBefore = ws.sent.length;
    const interrupted = result.current.flushDocument();
    const assertion = expect(interrupted).rejects.toThrow('disconnected');
    await waitFor(() => expect(ws.sent.length).toBe(sentBefore + 1));
    await act(async () => {
      ws.close(1012);
      await assertion;
    });
    await expect(result.current.flushDocument()).rejects.toThrow('not synchronized');
    unmount();
  });
});
