import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode, type ReactNode } from 'react';
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import * as awarenessProtocol from 'y-protocols/awareness';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getRealtimeToken: vi.fn(),
  getYjsUrl: vi.fn(),
}));

vi.mock('../services/auth', () => ({
  authService: { getSession: mocks.getSession },
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

describe('useYjsDocument', () => {
  beforeEach(() => {
    instances.length = 0;
    mocks.getSession.mockReset().mockResolvedValue({ idToken: 'id-token' });
    mocks.getRealtimeToken
      .mockReset()
      .mockResolvedValue({ token: 'scope-token', exp: Math.floor(Date.now() / 1000) + 600 });
    mocks.getYjsUrl.mockReset().mockReturnValue('wss://example.test/yjs/doc');
    vi.stubGlobal('WebSocket', MockWebSocket);
  });

  afterEach(() => {
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
});
