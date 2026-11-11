// OpenCode conversation-store sync. OpenCode uses SQLite under
// $XDG_DATA_HOME/opencode, so it must run on local disk and be copied as one
// subtree (database, WAL, SHM, and auxiliary files) to durable session storage.

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const OPENCODE_SUBDIR = 'opencode';
const locks = new Map();

export const resolveOpenCodeStore = (env = process.env) => {
  const localXdgDir = env.OPENCODE_XDG_DATA_HOME;
  const mountDir = env.V2_OPENCODE_STORE_DIR;
  if (!localXdgDir || !mountDir) return null;
  return { localXdgDir, mountDir };
};

const exists = async (target, fsImpl) => {
  try {
    await fsImpl.stat(target);
    return true;
  } catch {
    return false;
  }
};

export const hasOpenCodeStore = async ({ env = process.env, fs = { stat } } = {}) => {
  const store = resolveOpenCodeStore(env);
  return store ? exists(path.join(store.mountDir, OPENCODE_SUBDIR), fs) : false;
};

export const restoreOpenCodeStore = async ({
  env = process.env,
  fs = { cp, mkdir, rm, stat },
} = {}) => {
  const store = resolveOpenCodeStore(env);
  if (!store) return false;
  const src = path.join(store.mountDir, OPENCODE_SUBDIR);
  const dest = path.join(store.localXdgDir, OPENCODE_SUBDIR);
  if (!(await exists(src, fs))) return false;
  try {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(store.localXdgDir, { recursive: true });
    await fs.cp(src, dest, { recursive: true });
    return true;
  } catch {
    return false;
  }
};

export const persistOpenCodeStore = async ({
  env = process.env,
  fs = { cp, mkdir, rm, stat },
} = {}) => {
  const store = resolveOpenCodeStore(env);
  if (!store) return false;
  const src = path.join(store.localXdgDir, OPENCODE_SUBDIR);
  const dest = path.join(store.mountDir, OPENCODE_SUBDIR);
  if (!(await exists(src, fs))) return false;
  try {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(store.mountDir, { recursive: true });
    await fs.cp(src, dest, { recursive: true });
    return true;
  } catch {
    return false;
  }
};

export const OPENCODE_STORE_WAIT_EXPIRED = 'OPENCODE_STORE_WAIT_EXPIRED';

// Whether `previous` settles by `waitUntil` (epoch ms; null waits forever).
const turnArrives = (previous, waitUntil, now) => {
  const settled = previous.catch(() => {}).then(() => true);
  if (waitUntil === null) return settled;
  let timer;
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), Math.max(0, waitUntil - now()));
  });
  return Promise.race([settled, expired])
    .then((arrived) => arrived && now() <= waitUntil)
    .finally(() => clearTimeout(timer));
};

// Serialize the complete restore → execution → persist interval for a shared
// durable store. `finally` persistence runs for success, non-zero exits, and
// thrown spawn failures. A caller that must start by `waitUntil` gives up its
// turn instead of running late, and rejects with OPENCODE_STORE_WAIT_EXPIRED.
export const withOpenCodeStore = async ({
  env = process.env,
  operation,
  restore = restoreOpenCodeStore,
  persist = persistOpenCodeStore,
  waitUntil = null,
  now = Date.now,
} = {}) => {
  const store = resolveOpenCodeStore(env);
  const key = store?.mountDir ?? '__unconfigured__';
  const previous = locks.get(key) ?? Promise.resolve();
  let release;
  const turn = new Promise((resolve) => {
    release = resolve;
  });
  const tail = previous.catch(() => {}).then(() => turn);
  locks.set(key, tail);
  if (!(await turnArrives(previous, waitUntil, now))) {
    // The chain still waits for `previous`, so later callers never overlap the
    // current holder; the entry is dropped once that holder is done.
    release();
    void tail.then(() => {
      if (locks.get(key) === tail) locks.delete(key);
    });
    throw Object.assign(new Error('OpenCode store was not free in time'), {
      code: OPENCODE_STORE_WAIT_EXPIRED,
    });
  }
  try {
    await restore({ env }).catch(() => false);
    return await operation();
  } finally {
    await persist({ env }).catch(() => false);
    release();
    if (locks.get(key) === tail) locks.delete(key);
  }
};

export const __test = { OPENCODE_SUBDIR, locks };
