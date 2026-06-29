// Kiro conversation-store sync — bridges Kiro's SQLite store between the durable
// AgentCore managed-session mount and ephemeral local disk.
//
// Why: Kiro persists conversations to a SQLite DB (`kiro-cli/data.sqlite3`, plus
// WAL/SHM sidecars). The managed mount does NOT implement the fcntl byte-range
// locking SQLite needs, so the DB can't be opened directly on it ("database is
// locked"). Claude has no such problem (its store is append-only JSONL).
//
// So Kiro runs against an EPHEMERAL local XDG dir (locking works there), and we
// sync the store dir:
//   - restore (mount → local) BEFORE a Kiro spawn, so a resume after a microVM
//     reap recalls the parked conversation;
//   - persist (local → mount) AFTER the run (success OR park), the durable write.
//
// Layout (both roots hold the same `kiro-cli/` subdir Kiro creates under XDG):
//   localXdgDir = $XDG_DATA_HOME            (ephemeral, e.g. /home/node/.kiro-data)
//   mountDir    = $V2_KIRO_STORE_DIR        (durable,   e.g. /mnt/workspace/.kiro-data)
// We copy the whole `kiro-cli/` subtree (data.sqlite3 + -wal/-shm sidecars must
// travel together or the copy is corrupt). fs ops are injected for tests.

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

const KIRO_SUBDIR = 'kiro-cli';

// Resolve the two store roots from env. Returns null when not configured (e.g. a
// local/non-AgentCore run with no mount) — the caller then skips syncing.
export const resolveKiroStore = (env = process.env) => {
  const localXdgDir = env.XDG_DATA_HOME;
  const mountDir = env.V2_KIRO_STORE_DIR;
  if (!localXdgDir || !mountDir) return null;
  return { localXdgDir, mountDir };
};

const exists = async (p, fsImpl) => {
  try {
    await fsImpl.stat(p);
    return true;
  } catch {
    return false;
  }
};

// Restore the durable store (mount → local) before a Kiro spawn. Missing or
// unreadable source is NOT an error: Kiro just starts a fresh conversation (a
// resume then can't recall — surfaced by the caller as a logged warning). Returns
// true when a store was restored, false when there was nothing/failed to copy.
export const restoreKiroStore = async ({
  env = process.env,
  fs = { cp, mkdir, rm, stat },
} = {}) => {
  const store = resolveKiroStore(env);
  if (!store) return false;
  const src = path.join(store.mountDir, KIRO_SUBDIR);
  const dest = path.join(store.localXdgDir, KIRO_SUBDIR);
  if (!(await exists(src, fs))) return false;
  try {
    // Clear any stale local copy first so a partial older store can't shadow the
    // restored one, then copy the durable subtree down.
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(store.localXdgDir, { recursive: true });
    await fs.cp(src, dest, { recursive: true });
    return true;
  } catch {
    return false; // start-fresh; caller logs
  }
};

// Persist the live local store (local → mount) after a Kiro run. Best-effort: a
// failed persist must never fail the stage (the run already happened), but the
// caller should log it because a parked conversation then won't survive a reap.
// Returns true on a successful copy, false when there was nothing/failed.
export const persistKiroStore = async ({
  env = process.env,
  fs = { cp, mkdir, rm, stat },
} = {}) => {
  const store = resolveKiroStore(env);
  if (!store) return false;
  const src = path.join(store.localXdgDir, KIRO_SUBDIR);
  const dest = path.join(store.mountDir, KIRO_SUBDIR);
  if (!(await exists(src, fs))) return false;
  try {
    await fs.rm(dest, { recursive: true, force: true });
    await fs.mkdir(store.mountDir, { recursive: true });
    await fs.cp(src, dest, { recursive: true });
    return true;
  } catch {
    return false; // best-effort; caller logs
  }
};
