import { describe, it, expect } from 'vitest';
import { resolveKiroStore, restoreKiroStore, persistKiroStore } from '../cli/kiro-store.js';

const ENV = {
  XDG_DATA_HOME: '/home/node/.kiro-data',
  V2_KIRO_STORE_DIR: '/mnt/workspace/.kiro-data',
};

// A fake fs recording cp/mkdir/rm and answering stat from a set of existing paths.
const fakeFs = (existing = []) => {
  const present = new Set(existing);
  const calls = [];
  return {
    calls,
    present,
    async stat(p) {
      if (present.has(p)) return {};
      throw new Error('ENOENT');
    },
    async mkdir(p, opts) {
      calls.push(['mkdir', p, opts]);
    },
    async rm(p, opts) {
      calls.push(['rm', p, opts]);
    },
    async cp(src, dest, opts) {
      calls.push(['cp', src, dest, opts]);
      present.add(dest); // a copied dir now exists
    },
  };
};

describe('resolveKiroStore', () => {
  it('returns both roots when configured', () => {
    expect(resolveKiroStore(ENV)).toEqual({
      localXdgDir: '/home/node/.kiro-data',
      mountDir: '/mnt/workspace/.kiro-data',
    });
  });
  it('returns null when either root is unset (local/non-AgentCore run)', () => {
    expect(resolveKiroStore({ XDG_DATA_HOME: '/x' })).toBeNull();
    expect(resolveKiroStore({ V2_KIRO_STORE_DIR: '/m' })).toBeNull();
    expect(resolveKiroStore({})).toBeNull();
  });
});

describe('restoreKiroStore (mount → local)', () => {
  it('copies the durable kiro-cli subtree down, clearing any stale local copy', async () => {
    const fs = fakeFs(['/mnt/workspace/.kiro-data/kiro-cli']);
    const ok = await restoreKiroStore({ env: ENV, fs });
    expect(ok).toBe(true);
    // Stale local cleared, local root ensured, subtree copied down.
    expect(fs.calls).toContainEqual([
      'rm',
      '/home/node/.kiro-data/kiro-cli',
      { recursive: true, force: true },
    ]);
    expect(fs.calls).toContainEqual([
      'cp',
      '/mnt/workspace/.kiro-data/kiro-cli',
      '/home/node/.kiro-data/kiro-cli',
      { recursive: true },
    ]);
  });

  it('returns false (start-fresh) when the durable store does not exist', async () => {
    const fs = fakeFs([]); // nothing on the mount
    expect(await restoreKiroStore({ env: ENV, fs })).toBe(false);
    expect(fs.calls.some((c) => c[0] === 'cp')).toBe(false);
  });

  it('returns false when the store env is unset (no sync configured)', async () => {
    expect(await restoreKiroStore({ env: {}, fs: fakeFs() })).toBe(false);
  });
});

describe('persistKiroStore (local → mount)', () => {
  it('copies the live local subtree up to the durable mount', async () => {
    const fs = fakeFs(['/home/node/.kiro-data/kiro-cli']);
    const ok = await persistKiroStore({ env: ENV, fs });
    expect(ok).toBe(true);
    expect(fs.calls).toContainEqual([
      'cp',
      '/home/node/.kiro-data/kiro-cli',
      '/mnt/workspace/.kiro-data/kiro-cli',
      { recursive: true },
    ]);
  });

  it('returns false when there is no local store to persist', async () => {
    const fs = fakeFs([]);
    expect(await persistKiroStore({ env: ENV, fs })).toBe(false);
  });
});
