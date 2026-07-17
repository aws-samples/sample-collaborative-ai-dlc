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
