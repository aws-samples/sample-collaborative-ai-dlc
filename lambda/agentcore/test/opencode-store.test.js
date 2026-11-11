import { describe, it, expect, vi } from 'vitest';
import {
  OPENCODE_STORE_WAIT_EXPIRED,
  __test,
  resolveOpenCodeStore,
  restoreOpenCodeStore,
  persistOpenCodeStore,
  withOpenCodeStore,
} from '../cli/opencode-store.js';

const ENV = {
  OPENCODE_XDG_DATA_HOME: '/home/node/.opencode-data',
  V2_OPENCODE_STORE_DIR: '/mnt/workspace/.opencode-data',
};

const fakeFs = (existing = []) => {
  const present = new Set(existing);
  const calls = [];
  return {
    calls,
    async stat(target) {
      if (present.has(target)) return {};
      throw new Error('ENOENT');
    },
    async mkdir(target, options) {
      calls.push(['mkdir', target, options]);
    },
    async rm(target, options) {
      calls.push(['rm', target, options]);
    },
    async cp(src, dest, options) {
      calls.push(['cp', src, dest, options]);
      present.add(dest);
    },
  };
};

describe('OpenCode store sync', () => {
  it('resolves the OpenCode-specific local and durable roots', () => {
    expect(resolveOpenCodeStore(ENV)).toEqual({
      localXdgDir: '/home/node/.opencode-data',
      mountDir: '/mnt/workspace/.opencode-data',
    });
    expect(resolveOpenCodeStore({})).toBeNull();
  });

  it('restores and persists the whole opencode subtree, including SQLite sidecars', async () => {
    const restoreFs = fakeFs(['/mnt/workspace/.opencode-data/opencode']);
    expect(await restoreOpenCodeStore({ env: ENV, fs: restoreFs })).toBe(true);
    expect(restoreFs.calls).toContainEqual([
      'cp',
      '/mnt/workspace/.opencode-data/opencode',
      '/home/node/.opencode-data/opencode',
      { recursive: true },
    ]);

    const persistFs = fakeFs(['/home/node/.opencode-data/opencode']);
    expect(await persistOpenCodeStore({ env: ENV, fs: persistFs })).toBe(true);
    expect(persistFs.calls).toContainEqual([
      'cp',
      '/home/node/.opencode-data/opencode',
      '/mnt/workspace/.opencode-data/opencode',
      { recursive: true },
    ]);
  });

  it('returns false for missing data and copy failures', async () => {
    expect(await restoreOpenCodeStore({ env: ENV, fs: fakeFs() })).toBe(false);
    const fs = fakeFs(['/home/node/.opencode-data/opencode']);
    fs.cp = async () => {
      throw new Error('copy failed');
    };
    expect(await persistOpenCodeStore({ env: ENV, fs })).toBe(false);
  });

  it('persists in finally when the operation throws', async () => {
    const restore = vi.fn(async () => true);
    const persist = vi.fn(async () => true);
    await expect(
      withOpenCodeStore({
        env: ENV,
        restore,
        persist,
        operation: async () => {
          throw new Error('spawn failed');
        },
      }),
    ).rejects.toThrow('spawn failed');
    expect(restore).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });

  it('serializes executions that share a durable store', async () => {
    const order = [];
    let releaseFirst;
    const firstGate = new Promise((resolve) => {
      releaseFirst = resolve;
    });
    const first = withOpenCodeStore({
      env: ENV,
      restore: async () => order.push('restore-1'),
      persist: async () => order.push('persist-1'),
      operation: async () => {
        order.push('run-1');
        await firstGate;
      },
    });
    const second = withOpenCodeStore({
      env: ENV,
      restore: async () => order.push('restore-2'),
      persist: async () => order.push('persist-2'),
      operation: async () => order.push('run-2'),
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(order).toEqual(['restore-1', 'run-1']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['restore-1', 'run-1', 'persist-1', 'restore-2', 'run-2', 'persist-2']);
  });

  it('gives up a turn not reached by waitUntil without overlapping the holder', async () => {
    vi.useFakeTimers({ now: 0, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    try {
      const order = [];
      let releaseFirst;
      const firstGate = new Promise((resolve) => {
        releaseFirst = resolve;
      });
      const env = { ...ENV, V2_OPENCODE_STORE_DIR: '/mnt/workspace/.opencode-wait' };
      const quiet = { restore: async () => {}, persist: async () => {} };
      const first = withOpenCodeStore({
        env,
        ...quiet,
        operation: async () => {
          order.push('run-1');
          await firstGate;
          order.push('done-1');
        },
      });
      const late = withOpenCodeStore({
        env,
        ...quiet,
        waitUntil: 1_000,
        operation: async () => order.push('run-late'),
      });
      const lateResult = late.catch((error) => error.code);
      const third = withOpenCodeStore({
        env,
        ...quiet,
        operation: async () => order.push('run-3'),
      });
      await vi.advanceTimersByTimeAsync(1_001);
      expect(await lateResult).toBe(OPENCODE_STORE_WAIT_EXPIRED);
      expect(order).toEqual(['run-1']);
      releaseFirst();
      await Promise.all([first, third]);
      expect(order).toEqual(['run-1', 'done-1', 'run-3']);
      expect(__test.locks.has(env.V2_OPENCODE_STORE_DIR)).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('runs a bounded turn that arrives in time', async () => {
    const operation = vi.fn(async () => 'ran');
    await expect(
      withOpenCodeStore({
        env: { ...ENV, V2_OPENCODE_STORE_DIR: '/mnt/workspace/.opencode-free' },
        restore: async () => {},
        persist: async () => {},
        waitUntil: Date.now() + 60_000,
        operation,
      }),
    ).resolves.toBe('ran');
    expect(operation).toHaveBeenCalledOnce();
  });
});
