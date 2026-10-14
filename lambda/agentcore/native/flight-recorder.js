import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';

// Flight recorder for silent runtime deaths. A microVM that freezes or is
// hard-killed cannot log its own last seconds, so every second while busy the
// runtime writes a small ring of numeric samples to the per-run EFS mount. The
// next process on the session (a warm microVM taking over) logs that ring at
// boot. Numbers and fixed category keys only: no names, arguments, paths,
// identities or content.
export const NATIVE_FLIGHT_DIR = '/mnt/native/.native-flight';
export const NATIVE_FLIGHT_TICK_MS = 1000;
const IDLE_EVERY = 15;
const RING = 120;
const REPORTED = 60;
const SAMPLE_TIMEOUT_MS = 3_000;
const MAX_FILE_BYTES = 256 * 1024;
const KINDS = ['codex', 'aidlc', 'node', 'shell', 'git', 'other'];
const MB = 2 ** 20;
const kindOf = (name) => {
  if (name === 'codex' || name.startsWith('codex-')) return 'codex';
  if (name === 'aidlc' || name === 'bun') return 'aidlc';
  if (name === 'node' || name === 'MainThread') return 'node';
  if (['bash', 'sh', 'dash', 'zsh'].includes(name)) return 'shell';
  if (name === 'git' || name.startsWith('git-')) return 'git';
  return 'other';
};
const mb = (bytes) => (Number.isSafeInteger(bytes) && bytes >= 0 ? Math.round(bytes / MB) : null);

/**
 * Per-category process count and RSS (MB) from /proc; never throws. `procs`
 * always counts every process (cheap directory listing); the per-process reads
 * are bounded to two in flight and a time budget, because /proc reads slow down
 * or stall under memory pressure and must neither hold more than two of
 * libuv's few file-system threads nor blind the recorder. `scanned` says how
 * many processes the categories cover.
 */
export const flightProcessBreakdown = async ({
  readdir = fs.readdir,
  read = fs.readFile,
  budgetMs = 700,
  concurrency = 2,
  now = Date.now,
} = {}) => {
  const kinds = Object.fromEntries(KINDS.map((kind) => [kind, [0, 0]]));
  let pids = [];
  try {
    pids = (await readdir('/proc')).filter((name) => /^\d+$/.test(name));
  } catch {
    return { procs: null, scanned: null, kinds: null };
  }
  const deadline = now() + budgetMs;
  let next = 0;
  let scanned = 0;
  const worker = async () => {
    while (next < pids.length && now() < deadline) {
      const pid = pids[next++];
      const status = await read(`/proc/${pid}/status`, 'utf8').catch(() => null);
      if (!status) continue;
      const name = /^Name:\s*(\S{1,32})/m.exec(status)?.[1] ?? '';
      const rssKb = Number(/^VmRSS:\s+(\d{1,12}) kB/m.exec(status)?.[1] ?? 0);
      const entry = kinds[kindOf(name)];
      scanned++;
      entry[0]++;
      entry[1] += rssKb;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, pids.length) }, worker));
  for (const entry of Object.values(kinds)) entry[1] = Math.round(entry[1] / 1024);
  return { procs: pids.length, scanned, kinds };
};

const readNumber = async (read, path, pattern) => {
  const text = await read(path, 'utf8').catch(() => null);
  const match = pattern.exec(text ?? '');
  return match ? Number(match[1]) : null;
};

/** One compact sample. */
export const sampleNativeFlight = async ({
  lagMs,
  read = fs.readFile,
  readdir = fs.readdir,
  system = os,
  proc = process,
  now = Date.now,
} = {}) => {
  const used = await readNumber(read, '/sys/fs/cgroup/memory.current', /^(\d{1,19})\s*$/);
  const breakdown = await flightProcessBreakdown({ readdir, read });
  return {
    t: now(),
    lag: Number.isFinite(lagMs) ? Math.max(0, Math.round(lagMs)) : null,
    used: mb(used),
    free: mb(system.freemem()),
    rss: mb(proc.memoryUsage().rss),
    load: Number(system.loadavg()[0].toFixed(2)),
    oom: await readNumber(read, '/proc/vmstat', /^oom_kill (\d{1,19})$/m),
    procs: breakdown.procs,
    scanned: breakdown.scanned,
    k: breakdown.kinds,
  };
};

// A replayed sample is rebuilt from known numeric fields and the fixed
// category keys only: the ring lives on a mount the agent can also write.
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
export const flightSampleFromRecord = (value) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const kinds = value.k && typeof value.k === 'object' && !Array.isArray(value.k) ? value.k : null;
  return {
    t: num(value.t),
    lag: num(value.lag),
    used: num(value.used),
    free: num(value.free),
    rss: num(value.rss),
    load: num(value.load),
    oom: num(value.oom),
    procs: num(value.procs),
    scanned: num(value.scanned),
    k: kinds
      ? Object.fromEntries(
          KINDS.map((kind) => {
            const entry = Array.isArray(kinds[kind]) ? kinds[kind] : [];
            return [kind, [num(entry[0]), num(entry[1])]];
          }),
        )
      : null,
  };
};

// The previous boot's ring, if it was written by another process. Read
// without following links and bounded in size; any irregularity yields null.
const readPrevious = async ({ fsp, file }) => {
  let handle;
  try {
    handle = await fsp.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return null;
    const value = JSON.parse(await handle.readFile('utf8'));
    return value && typeof value.bootId === 'string' && Array.isArray(value.samples) ? value : null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => {});
  }
};

/**
 * Record every second while busy (every 15 s while idle). Returns
 * { stop, window } where window() reports maxima since its previous call.
 */
export const startNativeFlightRecorder = ({
  isBusy,
  dir = NATIVE_FLIGHT_DIR,
  tickMs = NATIVE_FLIGHT_TICK_MS,
  log = (event) => console.info(JSON.stringify(event)),
  sample = sampleNativeFlight,
  fsp = fs,
  now = Date.now,
  bootId = randomUUID(),
} = {}) => {
  const file = join(dir, 'recorder.json');
  const startedAt = now();
  const ring = [];
  let ready = false;
  let writing = false;
  let sampling = false;
  // Lag seen by ticks skipped while a scan was in progress; never dropped.
  let carriedLag = 0;
  // A timed-out scan that has not settled yet: never start another one beside it.
  let abandoned = null;
  let ticks = 0;
  let expected = startedAt + tickMs;
  let win = { lag: 0, used: 0, procs: 0, samples: 0 };
  const persist = async () => {
    if (!ready || writing) return;
    writing = true;
    const temp = `${file}.${bootId}.tmp`;
    try {
      await fsp.writeFile(
        temp,
        JSON.stringify({ schemaVersion: 1, bootId, startedAt, samples: ring }),
        {
          mode: 0o600,
          flag: 'w',
        },
      );
      await fsp.rename(temp, file);
    } catch {
      // Recording must never affect execution.
    } finally {
      writing = false;
    }
  };
  const boot = (async () => {
    try {
      await fsp.mkdir(dir, { mode: 0o700 }).catch((error) => {
        if (error.code !== 'EEXIST') throw error;
      });
      const stat = await fsp.lstat(dir);
      if (!stat.isDirectory() || stat.isSymbolicLink()) return;
      const previous = await readPrevious({ fsp, file });
      if (previous && previous.bootId !== bootId) {
        const samples = previous.samples
          .slice(-REPORTED)
          .map(flightSampleFromRecord)
          .filter(Boolean);
        const lastAt = samples.at(-1)?.t ?? null;
        log({
          type: 'native.flight.previous',
          at: now(),
          previousStartedAt: Number.isSafeInteger(previous.startedAt) ? previous.startedAt : null,
          previousLastAt: Number.isSafeInteger(lastAt) ? lastAt : null,
          gapToBootMs: Number.isSafeInteger(lastAt) ? startedAt - lastAt : null,
          samples,
        });
      }
      // A boot killed mid-write leaves its temporary file behind.
      for (const name of await fsp.readdir(dir).catch(() => []))
        if (/^recorder\.json\.[0-9a-f-]{36}\.tmp$/.test(name))
          await fsp.rm(join(dir, name), { force: true }).catch(() => {});
      ready = true;
    } catch {
      ready = false;
    }
  })();
  const timer = setInterval(async () => {
    const at = now();
    const lagMs = at - expected;
    expected = at + tickMs;
    ticks++;
    carriedLag = Math.max(carriedLag, Number.isFinite(lagMs) ? lagMs : 0);
    if (sampling || (isBusy() !== true && ticks % IDLE_EVERY !== 0)) return;
    sampling = true;
    const tickLag = carriedLag;
    carriedLag = 0;
    let timeout;
    try {
      let next;
      if (abandoned) {
        // Lag-only sample: no /proc or cgroup reads while one is still stuck.
        next = {
          t: now(),
          lag: Math.round(tickLag),
          used: null,
          free: null,
          rss: null,
          load: null,
          oom: null,
          procs: null,
          scanned: null,
          k: null,
        };
      } else {
        // A scan that never returns must not silence the recorder.
        const scan = sample({ lagMs: tickLag });
        next = await Promise.race([
          scan,
          new Promise((_, reject) => {
            timeout = setTimeout(() => {
              const settle = () => {
                if (abandoned === scan) abandoned = null;
              };
              abandoned = scan;
              scan.then(settle, settle);
              reject(new Error('flight sample timeout'));
            }, SAMPLE_TIMEOUT_MS);
            timeout.unref?.();
          }),
        ]);
      }
      ring.push(next);
      if (ring.length > RING) ring.splice(0, ring.length - RING);
      win = {
        lag: Math.max(win.lag, next.lag ?? 0),
        used: Math.max(win.used, next.used ?? 0),
        procs: Math.max(win.procs, next.procs ?? 0),
        samples: win.samples + 1,
      };
      // EFS persistence can stall independently of /proc sampling. Keep the
      // in-memory ring and telemetry windows current while the single guarded
      // write remains outstanding; never stack writes or await them on a tick.
      void persist();
    } catch {
      // Keep the lag that coincided with a failed or hung scan.
      carriedLag = Math.max(carriedLag, tickLag);
    } finally {
      clearTimeout(timeout);
      sampling = false;
    }
  }, tickMs);
  timer.unref?.();
  return {
    booted: boot,
    stop: () => clearInterval(timer),
    window: () => {
      const result = {
        maxLagMs: win.lag,
        maxUsedMB: win.used,
        maxProcs: win.procs,
        samples: win.samples,
      };
      win = { lag: 0, used: 0, procs: 0, samples: 0 };
      return result;
    },
  };
};
