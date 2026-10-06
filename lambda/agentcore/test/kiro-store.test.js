import { describe, it, expect } from 'vitest';
import { resolveKiroStore, restoreKiroStore, persistKiroStore } from '../cli/kiro-store.js';

const ENV = {
  HOME: '/home/node',
  XDG_DATA_HOME: '/home/node/.kiro-data',
  V2_KIRO_STORE_DIR: '/mnt/workspace/.kiro-data',
};

const LOCAL_DB = '/home/node/.kiro-data/kiro-cli';
const LOCAL_SESSIONS = '/home/node/.kiro/sessions';
const DURABLE_DB = '/mnt/workspace/.kiro-data/kiro-cli';
const DURABLE_SESSIONS = '/mnt/workspace/.kiro-data/sessions';

// A fake fs recording cp/mkdir/rm and answering stat from a set of existing paths.
const fakeFs = (existing = [], { failCp = new Set() } = {}) => {
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
      if (failCp.has(src)) throw new Error('EIO');
      present.add(dest); // a copied dir now exists
    },
  };
};

const copies = (fs) => fs.calls.filter((c) => c[0] === 'cp').map((c) => [c[1], c[2]]);

describe('resolveKiroStore', () => {
  it('pairs the SQLite tree and the v2 sessions tree with the durable mount', () => {
    expect(resolveKiroStore(ENV)).toEqual({
      mountDir: '/mnt/workspace/.kiro-data',
      trees: [
        { local: LOCAL_DB, durable: DURABLE_DB },
        { local: LOCAL_SESSIONS, durable: DURABLE_SESSIONS },
      ],
    });
  });
  it('follows KIRO_HOME for the sessions tree', () => {
    expect(resolveKiroStore({ ...ENV, KIRO_HOME: '/opt/kiro-home' }).trees[1]).toEqual({
      local: '/opt/kiro-home/sessions',
      durable: DURABLE_SESSIONS,
    });
  });
  it('returns null when a root is unset (local/non-AgentCore run)', () => {
    expect(resolveKiroStore({ ...ENV, XDG_DATA_HOME: '' })).toBeNull();
    expect(resolveKiroStore({ ...ENV, V2_KIRO_STORE_DIR: '' })).toBeNull();
    expect(resolveKiroStore({ ...ENV, HOME: '' })).toBeNull();
    expect(resolveKiroStore({})).toBeNull();
  });
});

describe('restoreKiroStore (mount → local)', () => {
  it('copies both durable trees down, clearing any stale local copy', async () => {
    const fs = fakeFs([DURABLE_DB, DURABLE_SESSIONS]);
    expect(await restoreKiroStore({ env: ENV, fs })).toBe(true);
    expect(fs.calls).toContainEqual(['rm', LOCAL_DB, { recursive: true, force: true }]);
    expect(fs.calls).toContainEqual(['rm', LOCAL_SESSIONS, { recursive: true, force: true }]);
    expect(fs.calls).toContainEqual(['mkdir', '/home/node/.kiro', { recursive: true }]);
    expect(copies(fs)).toEqual([
      [DURABLE_DB, LOCAL_DB],
      [DURABLE_SESSIONS, LOCAL_SESSIONS],
    ]);
  });

  it('restores a mount written before the sessions tree existed', async () => {
    // A stage parked by Kiro <= 2.19 left only kiro-cli/ on the mount.
    const fs = fakeFs([DURABLE_DB]);
    expect(await restoreKiroStore({ env: ENV, fs })).toBe(true);
    expect(copies(fs)).toEqual([[DURABLE_DB, LOCAL_DB]]);
  });

  it('returns false (start-fresh) when the durable store does not exist', async () => {
    const fs = fakeFs([]); // nothing on the mount
    expect(await restoreKiroStore({ env: ENV, fs })).toBe(false);
    expect(copies(fs)).toEqual([]);
  });

  it('returns false when any present tree fails to copy', async () => {
    const fs = fakeFs([DURABLE_DB, DURABLE_SESSIONS], { failCp: new Set([DURABLE_SESSIONS]) });
    expect(await restoreKiroStore({ env: ENV, fs })).toBe(false);
  });

  it('returns false when the store env is unset (no sync configured)', async () => {
    expect(await restoreKiroStore({ env: {}, fs: fakeFs() })).toBe(false);
  });
});

describe('persistKiroStore (local → mount)', () => {
  it('copies both live local trees up to the durable mount', async () => {
    const fs = fakeFs([LOCAL_DB, LOCAL_SESSIONS]);
    expect(await persistKiroStore({ env: ENV, fs })).toBe(true);
    expect(copies(fs)).toEqual([
      [LOCAL_DB, DURABLE_DB],
      [LOCAL_SESSIONS, DURABLE_SESSIONS],
    ]);
  });

  it('returns false when there is no local store to persist', async () => {
    const fs = fakeFs([]);
    expect(await persistKiroStore({ env: ENV, fs })).toBe(false);
  });

  it('returns false when a tree fails to copy', async () => {
    const fs = fakeFs([LOCAL_DB, LOCAL_SESSIONS], { failCp: new Set([LOCAL_DB]) });
    expect(await persistKiroStore({ env: ENV, fs })).toBe(false);
  });
});
