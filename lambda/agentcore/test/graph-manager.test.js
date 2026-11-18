import { describe, it, expect, vi } from 'vitest';
import { createGraphManager, isRetryableGraphAuthError } from '../mcp/graph-manager.js';
import { GraphWriteError } from '../mcp/graph-writer.js';

describe('createGraphManager', () => {
  const setup = ({ nowValue = 0, maxAgeMs = 240000 } = {}) => {
    let now = nowValue;
    let opened = 0;
    const closed = [];
    const writers = [];
    const openGraph = vi.fn(async () => ({ id: `g${++opened}` }));
    const closeGraphSource = vi.fn(async (g) => closed.push(g.id));
    const createWriter = vi.fn(({ g }) => {
      const writer = { id: `w-${g.id}`, calls: [] };
      writers.push(writer);
      return writer;
    });
    const manager = createGraphManager({
      openGraph,
      closeGraphSource,
      createWriter,
      scope: { intentId: 'i1' },
      now: () => now,
      maxAgeMs,
    });
    return {
      manager,
      openGraph,
      closeGraphSource,
      createWriter,
      closed,
      writers,
      setNow: (v) => (now = v),
    };
  };

  it('lazily opens once and reuses the writer within the max age', async () => {
    const h = setup();
    await h.manager.withWriter((writer) => writer.calls.push('a'));
    await h.manager.withWriter((writer) => writer.calls.push('b'));

    expect(h.openGraph).toHaveBeenCalledTimes(1);
    expect(h.createWriter).toHaveBeenCalledTimes(1);
    expect(h.closeGraphSource).not.toHaveBeenCalled();
    expect(h.writers[0].calls).toEqual(['a', 'b']);
  });

  it('refreshes before a call when the signed connection is too old', async () => {
    const h = setup({ maxAgeMs: 100 });
    await h.manager.withWriter((writer) => writer.calls.push('a'));
    h.setNow(100);
    await h.manager.withWriter((writer) => writer.calls.push('b'));

    expect(h.openGraph).toHaveBeenCalledTimes(2);
    expect(h.closed).toEqual(['g1']);
    expect(h.writers.map((w) => w.calls)).toEqual([['a'], ['b']]);
  });

  it('closes, reconnects, and retries once on stale SigV4 403 errors', async () => {
    const h = setup();
    let attempts = 0;
    const result = await h.manager.withWriter((writer) => {
      attempts += 1;
      if (attempts === 1) throw new Error('Unexpected server response: 403 Signature expired');
      writer.calls.push('retried');
      return writer.id;
    });

    expect(result).toBe('w-g2');
    expect(h.openGraph).toHaveBeenCalledTimes(2);
    expect(h.closed).toEqual(['g1']);
    expect(h.writers[1].calls).toEqual(['retried']);
  });

  it('does not retry graph validation failures', async () => {
    const h = setup();
    await expect(
      h.manager.withWriter(() => {
        throw new GraphWriteError('duplicate id');
      }),
    ).rejects.toThrow('duplicate id');

    expect(h.openGraph).toHaveBeenCalledTimes(1);
    expect(h.closeGraphSource).not.toHaveBeenCalled();
  });
});

describe('createGraphManager.withGraph', () => {
  const setup = ({ maxAgeMs = 240000 } = {}) => {
    let now = 0;
    let opened = 0;
    const closed = [];
    const openGraph = vi.fn(async () => ({ id: `g${++opened}` }));
    const manager = createGraphManager({
      openGraph,
      closeGraphSource: async (g) => closed.push(g.id),
      now: () => now,
      maxAgeMs,
    });
    return { manager, openGraph, closed, setNow: (v) => (now = v) };
  };
  const authError = () => new Error('Unexpected server response: 403 Signature expired');

  it('shares one connection across calls and needs no writer factory', async () => {
    const h = setup();
    const seen = [];
    await h.manager.withGraph(async (g) => seen.push(g.id));
    await h.manager.withGraph(async (g) => seen.push(g.id));
    expect(seen).toEqual(['g1', 'g1']);
    expect(h.openGraph).toHaveBeenCalledTimes(1);
  });

  it('refreshes an aged connection and closes the old one', async () => {
    const h = setup({ maxAgeMs: 100 });
    await h.manager.withGraph(async () => {});
    h.setNow(100);
    const id = await h.manager.withGraph(async (g) => g.id);
    expect(id).toBe('g2');
    expect(h.closed).toEqual(['g1']);
  });

  it('replays an auth rejection only when the caller marks it replay-safe', async () => {
    const h = setup();
    let attempts = 0;
    const result = await h.manager.withGraph(
      async (g) => {
        attempts += 1;
        if (attempts === 1) throw authError();
        return g.id;
      },
      { retryAuth: true },
    );
    expect(result).toBe('g2');
    expect(h.closed).toEqual(['g1']);
  });

  it('invalidates but never replays a mutation that hit an auth rejection', async () => {
    const h = setup();
    const fn = vi.fn(async () => {
      throw authError();
    });
    await expect(h.manager.withGraph(fn)).rejects.toThrow('403');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.closed).toEqual(['g1']);
    expect(await h.manager.withGraph(async (g) => g.id)).toBe('g2');
  });

  it('drops a connection whose socket closed, without replaying', async () => {
    const h = setup();
    const fn = vi.fn(async () => {
      throw new Error('WebSocket is not open: readyState 3 (CLOSED)');
    });
    await expect(h.manager.withGraph(fn, { retryAuth: true })).rejects.toThrow('not open');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(h.closed).toEqual(['g1']);
  });

  it('keeps the connection on an ordinary graph error', async () => {
    const h = setup();
    await expect(
      h.manager.withGraph(async () => {
        throw new GraphWriteError('bad edge');
      }),
    ).rejects.toThrow('bad edge');
    expect(h.closed).toEqual([]);
    expect(await h.manager.withGraph(async (g) => g.id)).toBe('g1');
  });
});

describe('isRetryableGraphAuthError', () => {
  it('matches stale Neptune SigV4 403 shapes', () => {
    expect(
      isRetryableGraphAuthError(new Error('Unexpected server response: 403 Signature expired')),
    ).toBe(true);
    expect(
      isRetryableGraphAuthError({
        $metadata: { httpStatusCode: 403 },
        message: 'X-Amz-Date expired',
      }),
    ).toBe(true);
  });

  it('does not match graph write validation errors', () => {
    expect(isRetryableGraphAuthError(new GraphWriteError('bad edge'))).toBe(false);
  });
});
