// Kiro conversation-store sync — bridges Kiro's local stores between the durable
// AgentCore managed-session mount and ephemeral local disk.
//
// Why: Kiro keeps state in two local trees:
//   - `$XDG_DATA_HOME/kiro-cli/` — a SQLite DB (`data.sqlite3`, plus WAL/SHM
//     sidecars) holding classic (v1-engine) conversations and CLI state. The
//     managed mount does NOT implement the fcntl byte-range locking SQLite needs,
//     so the DB can't be opened directly on it ("database is locked").
//   - `$KIRO_HOME/sessions/` (default `~/.kiro/sessions/`) — the v2 engine's
//     per-session JSON + JSONL files, which `--resume-id` loads.
// Both live outside the mount, so both must be carried across a microVM reap.
//
// So Kiro runs against EPHEMERAL local dirs (locking works there), and we sync
// each tree:
//   - restore (mount → local) BEFORE a Kiro spawn, so a resume after a microVM
//     reap recalls the parked conversation;
//   - persist (local → mount) AFTER the run (success OR park), the durable write.
//
// Layout (each tree keeps its basename under the mount):
//   $XDG_DATA_HOME/kiro-cli  ↔ $V2_KIRO_STORE_DIR/kiro-cli
//   $KIRO_HOME/sessions      ↔ $V2_KIRO_STORE_DIR/sessions
// We copy whole subtrees (data.sqlite3 + -wal/-shm sidecars must travel together
// or the copy is corrupt). fs ops are injected for tests.

import { cp, mkdir, rm, stat } from 'node:fs/promises';
import path from 'node:path';

// Resolve the local ↔ durable tree pairs from env. Returns null when not
// configured (e.g. a local/non-AgentCore run with no mount) — the caller then
// skips syncing.
export const resolveKiroStore = (env = process.env) => {
  const localXdgDir = env.XDG_DATA_HOME;
  const mountDir = env.V2_KIRO_STORE_DIR;
  const kiroHome = env.KIRO_HOME || (env.HOME ? path.join(env.HOME, '.kiro') : null);
  if (!localXdgDir || !mountDir || !kiroHome) return null;
  return {
    mountDir,
    trees: [
      { local: path.join(localXdgDir, 'kiro-cli'), durable: path.join(mountDir, 'kiro-cli') },
      { local: path.join(kiroHome, 'sessions'), durable: path.join(mountDir, 'sessions') },
    ],
  };
};

const exists = async (p, fsImpl) => {
  try {
    await fsImpl.stat(p);
    return true;
  } catch {
    return false;
  }
};

// Replace each `to` with a copy of its `from` tree when `from` exists. Returns
// true when at least one tree was copied and none failed.
const copyTrees = async (pairs, fsImpl) => {
  let copied = 0;
  for (const { from, to } of pairs) {
    if (!(await exists(from, fsImpl))) continue;
    try {
      // Clear the stale copy first so a partial older tree can't shadow the
      // fresh one, then copy the subtree across.
      await fsImpl.rm(to, { recursive: true, force: true });
      await fsImpl.mkdir(path.dirname(to), { recursive: true });
      await fsImpl.cp(from, to, { recursive: true });
      copied += 1;
    } catch {
      return false;
    }
  }
  return copied > 0;
};

// Restore the durable store (mount → local) before a Kiro spawn. Missing or
// unreadable source is NOT an error here: Kiro just starts a fresh conversation.
// On a FRESH run that is correct; on a RESUME the caller (run-stage) treats a
// false return as a lost conversation when a mount is configured, because a
// blank resume silently loses the parked stage's whole context. A mount written
// before the sessions tree existed restores only `kiro-cli/`. Returns true when a
// store was restored, false when there was nothing/failed to copy.
export const restoreKiroStore = async ({
  env = process.env,
  fs = { cp, mkdir, rm, stat },
} = {}) => {
  const store = resolveKiroStore(env);
  if (!store) return false;
  return copyTrees(
    store.trees.map((tree) => ({ from: tree.durable, to: tree.local })),
    fs,
  );
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
  return copyTrees(
    store.trees.map((tree) => ({ from: tree.local, to: tree.durable })),
    fs,
  );
};
