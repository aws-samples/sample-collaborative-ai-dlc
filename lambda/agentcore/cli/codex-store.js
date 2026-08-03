// Codex rollout persistence — bridges one resumable thread between ephemeral
// local CODEX_HOME storage and the AgentCore managed-session mount.
//
// Codex continuously appends rollout JSONL while it runs. Writing CODEX_HOME
// directly on the managed mount can saturate the mount's write-back pipeline
// even while statfs reports free bytes. Live Codex state therefore stays local;
// only the selected thread's validated rollout is copied to durable storage
// after the process exits.

import { copyFile, mkdir, readdir, rename, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import path from 'node:path';

export const DEFAULT_CODEX_HOME_ROOT = '/home/node/.codex-runs';

const SESSIONS_DIR = 'sessions';
const MAX_ATTEMPTS = 5;
const RETRY_DELAYS_MS = [250, 500, 1000, 2000];
const SAFE_THREAD_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const RETRYABLE_CODES = new Set(['ENOSPC', 'EDQUOT', 'EAGAIN', 'EBUSY', 'ETIMEDOUT']);

const DEFAULT_FS = { copyFile, mkdir, readdir, rename, rm };

const errorInfo = (error) => ({
  code: error?.code ?? null,
  message: error?.message ?? String(error),
});

const isMissing = (error) => error?.code === 'ENOENT';

const isSafeThreadId = (threadId) => typeof threadId === 'string' && SAFE_THREAD_ID.test(threadId);

const isWithin = (root, target) => {
  const relative = path.relative(path.resolve(root), path.resolve(target));
  return (
    relative !== '' &&
    !relative.startsWith(`..${path.sep}`) &&
    relative !== '..' &&
    !path.isAbsolute(relative)
  );
};

const retryable = (error) =>
  RETRYABLE_CODES.has(error?.code) || /waiting to be backed up/i.test(error?.message ?? '');

const sleepFor = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export const resolveCodexStore = ({ env = process.env, codexHome } = {}) => {
  const durableHome = env.V2_CODEX_STORE_DIR;
  if (!codexHome || !durableHome) return null;
  return {
    localHome: path.resolve(codexHome),
    durableHome: path.resolve(durableHome),
  };
};

const collectRolloutCandidates = async ({ sessionsRoot, threadId, fs }) => {
  const suffix = `-${threadId}.jsonl`;
  const found = [];

  const visit = async (dir) => {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(target);
      } else if (entry.isFile() && entry.name.endsWith(suffix) && isWithin(sessionsRoot, target)) {
        found.push(target);
      }
    }
  };

  await visit(sessionsRoot);
  return found;
};

const rolloutThreadId = (event) =>
  event?.payload?.id ?? event?.payload?.thread_id ?? event?.thread_id ?? event?.session_id ?? null;

// Validate the entire JSONL file before it can replace a known-good durable
// copy. This catches an ENOSPC-truncated final record, not just a bad header.
const validateRollout = async ({ filename, threadId, createReadStreamFn }) => {
  let firstEvent = null;
  let lineCount = 0;
  try {
    const lines = createInterface({
      input: createReadStreamFn(filename, { encoding: 'utf8' }),
      crlfDelay: Infinity,
    });
    for await (const raw of lines) {
      const line = raw.trim();
      if (!line) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return { ok: false, status: 'corrupt' };
      }
      firstEvent ??= event;
      lineCount += 1;
    }
  } catch (error) {
    return { ok: false, status: 'io_error', error: errorInfo(error) };
  }

  if (
    lineCount === 0 ||
    firstEvent?.type !== 'session_meta' ||
    rolloutThreadId(firstEvent) !== threadId
  ) {
    return { ok: false, status: 'corrupt' };
  }
  return { ok: true };
};

export const findCodexRollout = async ({
  homeDir,
  threadId,
  fs: fsOverrides = {},
  createReadStreamFn = createReadStream,
} = {}) => {
  if (!isSafeThreadId(threadId)) return { ok: false, status: 'invalid_thread_id' };
  if (!homeDir) return { ok: false, status: 'unconfigured' };

  const fs = { ...DEFAULT_FS, ...fsOverrides };
  const sessionsRoot = path.join(path.resolve(homeDir), SESSIONS_DIR);
  let candidates;
  try {
    candidates = await collectRolloutCandidates({ sessionsRoot, threadId, fs });
  } catch (error) {
    return { ok: false, status: 'io_error', error: errorInfo(error) };
  }
  if (candidates.length === 0) return { ok: false, status: 'missing' };

  const valid = [];
  let validationFailure = null;
  for (const filename of candidates) {
    const result = await validateRollout({ filename, threadId, createReadStreamFn });
    if (result.ok) valid.push(filename);
    else if (result.status === 'io_error') validationFailure = result;
  }
  if (valid.length > 1) return { ok: false, status: 'ambiguous' };
  if (valid.length === 0) {
    return validationFailure ?? { ok: false, status: 'corrupt' };
  }

  const relativePath = path.relative(sessionsRoot, valid[0]);
  if (
    !relativePath ||
    relativePath.startsWith(`..${path.sep}`) ||
    relativePath === '..' ||
    path.isAbsolute(relativePath)
  ) {
    return { ok: false, status: 'invalid_path' };
  }
  return { ok: true, status: 'found', filename: valid[0], relativePath };
};

export const restoreCodexRollout = async ({
  threadId,
  codexHome,
  env = process.env,
  fs: fsOverrides = {},
  createReadStreamFn = createReadStream,
} = {}) => {
  const store = resolveCodexStore({ env, codexHome });
  if (!store) return { ok: false, status: 'unconfigured' };
  const fs = { ...DEFAULT_FS, ...fsOverrides };
  const found = await findCodexRollout({
    homeDir: store.durableHome,
    threadId,
    fs,
    createReadStreamFn,
  });
  if (!found.ok) return found;

  const localSessions = path.join(store.localHome, SESSIONS_DIR);
  const destination = path.join(localSessions, found.relativePath);
  if (!isWithin(localSessions, destination)) {
    return { ok: false, status: 'invalid_path' };
  }
  try {
    await fs.rm(localSessions, { recursive: true, force: true });
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.copyFile(found.filename, destination);
    return {
      ok: true,
      status: 'restored',
      relativePath: found.relativePath,
    };
  } catch (error) {
    await fs.rm(localSessions, { recursive: true, force: true }).catch(() => {});
    return { ok: false, status: 'io_error', error: errorInfo(error) };
  }
};

export const persistCodexRollout = async ({
  threadId,
  codexHome,
  env = process.env,
  fs: fsOverrides = {},
  createReadStreamFn = createReadStream,
  sleep = sleepFor,
  ids = randomUUID,
} = {}) => {
  const store = resolveCodexStore({ env, codexHome });
  if (!store) return { ok: false, status: 'unconfigured' };
  const fs = { ...DEFAULT_FS, ...fsOverrides };
  const found = await findCodexRollout({
    homeDir: store.localHome,
    threadId,
    fs,
    createReadStreamFn,
  });
  if (!found.ok) return found;

  const durableSessions = path.join(store.durableHome, SESSIONS_DIR);
  const destination = path.join(durableSessions, found.relativePath);
  if (!isWithin(durableSessions, destination)) {
    return { ok: false, status: 'invalid_path' };
  }

  let lastError = null;
  let attempts = 0;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    attempts = attempt;
    const temporary = path.join(
      path.dirname(destination),
      `.${path.basename(destination)}.${process.pid}.${ids()}.tmp`,
    );
    try {
      await fs.mkdir(path.dirname(destination), { recursive: true });
      await fs.rm(temporary, { force: true });
      await fs.copyFile(found.filename, temporary);
      await fs.rename(temporary, destination);
      return {
        ok: true,
        status: 'persisted',
        relativePath: found.relativePath,
        attempts: attempt,
      };
    } catch (error) {
      lastError = error;
      await fs.rm(temporary, { force: true }).catch(() => {});
      if (!retryable(error) || attempt === MAX_ATTEMPTS) break;
      await sleep(RETRY_DELAYS_MS[attempt - 1]);
    }
  }
  return {
    ok: false,
    status: 'persist_failed',
    attempts,
    error: errorInfo(lastError),
  };
};

export const cleanupCodexHome = async ({
  codexHome,
  env = process.env,
  fs: fsOverrides = {},
} = {}) => {
  if (!codexHome) return false;
  const fs = { ...DEFAULT_FS, ...fsOverrides };
  const root = path.resolve(env.V2_CODEX_HOME_ROOT || DEFAULT_CODEX_HOME_ROOT);
  const target = path.resolve(codexHome);
  if (!isWithin(root, target)) return false;
  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
};

export const __test = {
  MAX_ATTEMPTS,
  RETRY_DELAYS_MS,
  isSafeThreadId,
  retryable,
};
