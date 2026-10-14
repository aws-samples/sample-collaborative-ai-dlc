import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  flightProcessBreakdown,
  flightSampleFromRecord,
  sampleNativeFlight,
  startNativeFlightRecorder,
} from '../native/flight-recorder.js';

const status = (name, rssKb) => `Name:\t${name}\nState:\tS (sleeping)\nVmRSS:\t ${rssKb} kB\n`;
const procs = {
  1: status('tini', 900),
  7: status('node', 180 * 1024),
  20: status('codex', 120 * 1024),
  31: status('aidlc', 200 * 1024),
  32: status('bun', 140 * 1024),
  40: status('bash', 4 * 1024),
  41: status('git-remote-https', 10 * 1024),
  50: status('secret-tool-name', 2 * 1024),
};
const readdir = vi.fn(async () => [...Object.keys(procs), 'self', 'meminfo']);
const read = vi.fn(async (path) => {
  const pid = /^\/proc\/(\d+)\/status$/.exec(path)?.[1];
  if (pid && procs[pid]) return procs[pid];
  if (path === '/sys/fs/cgroup/memory.current') return `${3 * 2 ** 30}\n`;
  if (path === '/proc/vmstat') return 'nr_free_pages 1\noom_kill 2\n';
  throw Object.assign(new Error('missing'), { code: 'ENOENT' });
});
const system = { freemem: () => 5 * 2 ** 30, loadavg: () => [2.345, 0, 0] };
const proc = { memoryUsage: () => ({ rss: 180 * 2 ** 20 }) };

let dir;
beforeEach(async () => {
  dir = join(await fs.realpath(await fs.mkdtemp(join(tmpdir(), 'native-flight-'))), 'flight');
});
afterEach(async () => {
  vi.useRealTimers();
  // A write that was in flight when the recorder stopped may still land.
  await new Promise((resolve) => setTimeout(resolve, 20));
  await fs.rm(join(dir, '..'), { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

describe('flight samples', () => {
  it('groups processes into fixed categories without names', async () => {
    expect(await flightProcessBreakdown({ readdir, read })).toEqual({
      procs: 8,
      scanned: 8,
      kinds: {
        codex: [1, 120],
        aidlc: [2, 340],
        node: [1, 180],
        shell: [1, 4],
        git: [1, 10],
        other: [2, 3],
      },
    });
  });

  it('never has more than two /proc reads in flight', async () => {
    let active = 0,
      maxActive = 0;
    const slowRead = vi.fn(async (path) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 2));
      active--;
      return read(path);
    });
    expect(await flightProcessBreakdown({ readdir, read: slowRead })).toMatchObject({
      procs: 8,
      scanned: 8,
    });
    expect(maxActive).toBe(2);
  });

  it('stops reading at its time budget but still counts every process', async () => {
    let clock = 0;
    const slowRead = vi.fn(async (path) => {
      clock += 300;
      return read(path);
    });
    const result = await flightProcessBreakdown({
      readdir,
      read: slowRead,
      budgetMs: 700,
      now: () => clock,
    });
    expect(result.procs).toBe(8);
    expect(result.scanned).toBeLessThan(8);
    expect(slowRead.mock.calls.length).toBeLessThan(8);
  });

  it('records numbers only, with lag, memory, OOM count and processes', async () => {
    const sample = await sampleNativeFlight({
      lagMs: 37.4,
      read,
      readdir,
      system,
      proc,
      now: () => 9,
    });
    expect(sample).toMatchObject({
      t: 9,
      lag: 37,
      used: 3072,
      free: 5120,
      rss: 180,
      load: 2.35,
      oom: 2,
      procs: 8,
    });
    expect(JSON.stringify(sample)).not.toMatch(/tini|secret|bash|git-remote/);
  });

  it('degrades to nulls when /proc and cgroup are unavailable', async () => {
    const fail = vi.fn(async () => {
      throw new Error('denied');
    });
    expect(await sampleNativeFlight({ read: fail, readdir: fail, system, proc })).toMatchObject({
      used: null,
      oom: null,
      procs: null,
      k: null,
    });
  });
});

describe('flight recorder', () => {
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  // Under fake timers a real file write never settles; keep the real directory
  // checks at boot and make the per-tick writes instant.
  const instant = { ...fs, writeFile: async () => {}, rename: async () => {} };
  const fake = (t) => ({
    t,
    lag: 0,
    used: 100 + t,
    free: 1,
    rss: 1,
    load: 0,
    oom: 0,
    procs: t,
    k: null,
  });

  it('writes a bounded ring to the mount every tick while busy and reports window maxima', async () => {
    let t = 0;
    const recorder = startNativeFlightRecorder({
      isBusy: () => true,
      dir,
      tickMs: 10,
      sample: async () => fake(++t),
      log: vi.fn(),
    });
    await recorder.booted;
    await wait(120);
    recorder.stop();
    await wait(30);
    const saved = JSON.parse(await fs.readFile(join(dir, 'recorder.json'), 'utf8'));
    expect(saved.schemaVersion).toBe(1);
    expect(saved.samples.length).toBeGreaterThan(3);
    expect(saved.samples.length).toBeLessThanOrEqual(120);
    expect((await fs.stat(dir)).mode & 0o777).toBe(0o700);
    const window = recorder.window();
    expect(window.samples).toBeGreaterThan(3);
    expect(window.maxProcs).toBe(t);
    expect(recorder.window()).toEqual({ maxLagMs: 0, maxUsedMB: 0, maxProcs: 0, samples: 0 });
  });

  it("logs the previous boot's last samples at boot", async () => {
    await fs.mkdir(dir, { mode: 0o700 });
    const samples = Array.from({ length: 90 }, (_, i) => fake(1000 + i));
    await fs.writeFile(
      join(dir, 'recorder.json'),
      JSON.stringify({ schemaVersion: 1, bootId: 'old', startedAt: 500, samples }),
    );
    const log = vi.fn();
    const recorder = startNativeFlightRecorder({
      isBusy: () => false,
      dir,
      tickMs: 10_000,
      sample: async () => fake(1),
      log,
      now: () => 5000,
    });
    await recorder.booted;
    recorder.stop();
    expect(log).toHaveBeenCalledTimes(1);
    const [event] = log.mock.calls[0];
    expect(event).toMatchObject({
      type: 'native.flight.previous',
      previousStartedAt: 500,
      previousLastAt: 1089,
      gapToBootMs: 5000 - 1089,
    });
    expect(event.samples).toHaveLength(60);
    expect(event.samples[0].t).toBe(1030);
  });

  it('replays only numeric fields and fixed categories from a tampered ring, and removes stale temp files', async () => {
    await fs.mkdir(dir, { mode: 0o700 });
    const tampered = {
      t: 5,
      lag: 'x'.repeat(5000),
      used: 7,
      procs: 3,
      note: 'agent text',
      k: { codex: [1, 2], evil: [9, 9], aidlc: ['a', 3] },
    };
    await fs.writeFile(
      join(dir, 'recorder.json'),
      JSON.stringify({ bootId: 'old', startedAt: 'nope', samples: [tampered, 'str', null, [1]] }),
    );
    const stale = join(dir, 'recorder.json.0f8fad5b-d9cb-469f-a165-70867728950e.tmp');
    await fs.writeFile(stale, '{}');
    const log = vi.fn();
    const recorder = startNativeFlightRecorder({
      isBusy: () => false,
      dir,
      tickMs: 10_000,
      sample: async () => fake(1),
      log,
      now: () => 50,
    });
    await recorder.booted;
    recorder.stop();
    const [event] = log.mock.calls[0];
    expect(event.previousStartedAt).toBeNull();
    expect(event.samples).toEqual([
      {
        t: 5,
        lag: null,
        used: 7,
        free: null,
        rss: null,
        load: null,
        oom: null,
        procs: 3,
        scanned: null,
        k: {
          codex: [1, 2],
          aidlc: [null, 3],
          node: [null, null],
          shell: [null, null],
          git: [null, null],
          other: [null, null],
        },
      },
    ]);
    expect(JSON.stringify(event)).not.toMatch(/agent text|evil|xxxx/);
    await expect(fs.stat(stale)).rejects.toThrow();
    expect(flightSampleFromRecord('str')).toBeNull();
  });

  it('never stacks samples when one scan outlasts a tick', async () => {
    let active = 0,
      maxActive = 0;
    const sample = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await wait(40);
      active--;
      return fake(1);
    };
    const recorder = startNativeFlightRecorder({
      isBusy: () => true,
      dir,
      tickMs: 5,
      sample,
      log: vi.fn(),
    });
    await recorder.booted;
    await wait(150);
    recorder.stop();
    await wait(60);
    expect(maxActive).toBe(1);
  });

  it.each(['writeFile', 'rename'])(
    'keeps sampling through a stuck %s without stacking persistence',
    async (operation) => {
      vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
      let release;
      const blocked = new Promise((resolve) => {
        release = resolve;
      });
      let t = 0;
      const sample = vi.fn(async () => fake(++t));
      const fsp = {
        ...instant,
        [operation]: vi.fn().mockReturnValueOnce(blocked).mockResolvedValue(undefined),
      };
      const recorder = startNativeFlightRecorder({
        isBusy: () => true,
        dir,
        sample,
        fsp,
        log: vi.fn(),
      });
      try {
        await recorder.booted;
        await vi.advanceTimersByTimeAsync(5000);
        expect(fsp[operation]).toHaveBeenCalledTimes(1);
        expect(sample).toHaveBeenCalledTimes(5);
        expect(recorder.window()).toMatchObject({ samples: 5, maxProcs: 5 });
        release();
        await vi.advanceTimersByTimeAsync(1000);
        expect(fsp[operation]).toHaveBeenCalledTimes(2);
        expect(recorder.window()).toMatchObject({ samples: 1, maxProcs: 6 });
      } finally {
        recorder.stop();
        release();
      }
    },
  );

  it('carries the lag of ticks skipped during a slow scan into the next sample', async () => {
    let now = 0;
    const lags = [];
    let release;
    const sample = vi.fn(async ({ lagMs }) => {
      lags.push(lagMs);
      if (lags.length === 1)
        await new Promise((resolve) => {
          release = resolve;
        });
      return fake(1);
    });
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const recorder = startNativeFlightRecorder({
      isBusy: () => true,
      dir,
      tickMs: 1000,
      sample,
      log: vi.fn(),
      fsp: instant,
      now: () => now,
    });
    await recorder.booted;
    now = 1000;
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    // A 4 s stall ends while the first scan is still running: that tick is skipped.
    now = 6000;
    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    release();
    await wait(5);
    now = 7000;
    vi.advanceTimersByTime(1000);
    await wait(5);
    recorder.stop();
    expect(lags[0]).toBe(0);
    expect(lags[1]).toBeGreaterThanOrEqual(4000);
  });

  it('times out a hung scan, never starts a second one beside it, and keeps its lag', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'setTimeout', 'clearTimeout'] });
    let t = 0;
    let release;
    const sample = vi.fn(async ({ lagMs }) => {
      if (sample.mock.calls.length === 1)
        return new Promise((resolve) => {
          release = () => resolve(fake(1));
        });
      return { ...fake(2), lag: lagMs };
    });
    const recorder = startNativeFlightRecorder({
      isBusy: () => true,
      dir,
      tickMs: 1000,
      sample,
      log: vi.fn(),
      fsp: instant,
      now: () => (t += 1000),
    });
    await recorder.booted;
    // The first scan hangs past the 10 s timeout; later ticks record lag-only samples.
    await vi.advanceTimersByTimeAsync(9_000);
    expect(sample).toHaveBeenCalledTimes(1);
    // Lag-only samples were recorded meanwhile (no process or memory data).
    const meanwhile = recorder.window();
    expect(meanwhile.samples).toBeGreaterThan(0);
    expect(meanwhile.maxProcs).toBe(0);
    expect(meanwhile.maxUsedMB).toBe(0);
    // Once the stuck scan settles, full scans resume.
    release();
    await vi.advanceTimersByTimeAsync(3000);
    recorder.stop();
    expect(sample.mock.calls.length).toBeGreaterThan(1);
  });

  it('keeps the lag of a scan that failed for the next sample', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    let now = 0;
    const lags = [];
    const sample = vi.fn(async ({ lagMs }) => {
      lags.push(lagMs);
      if (lags.length === 1) throw new Error('scan failed');
      return fake(1);
    });
    const recorder = startNativeFlightRecorder({
      isBusy: () => true,
      dir,
      tickMs: 1000,
      sample,
      log: vi.fn(),
      fsp: instant,
      now: () => now,
    });
    await recorder.booted;
    now = 5000;
    await vi.advanceTimersByTimeAsync(1000);
    now = 6000;
    await vi.advanceTimersByTimeAsync(1000);
    recorder.stop();
    expect(lags[0]).toBeGreaterThanOrEqual(4000);
    expect(lags[1]).toBeGreaterThanOrEqual(4000);
  });

  it.each([
    [
      'a symlinked ring',
      async () => {
        await fs.mkdir(dir, { mode: 0o700 });
        await fs.writeFile(
          join(dir, '..', 'elsewhere.json'),
          JSON.stringify({ bootId: 'old', samples: [] }),
        );
        await fs.symlink(join(dir, '..', 'elsewhere.json'), join(dir, 'recorder.json'));
      },
    ],
    [
      'an oversized ring',
      async () => {
        await fs.mkdir(dir, { mode: 0o700 });
        await fs.writeFile(
          join(dir, 'recorder.json'),
          JSON.stringify({ bootId: 'old', samples: ['x'.repeat(300 * 1024)] }),
        );
      },
    ],
    [
      'a malformed ring',
      async () => {
        await fs.mkdir(dir, { mode: 0o700 });
        await fs.writeFile(join(dir, 'recorder.json'), '{"bootId":');
      },
    ],
  ])('ignores %s', async (_name, setup) => {
    await setup();
    const log = vi.fn();
    const recorder = startNativeFlightRecorder({
      isBusy: () => false,
      dir,
      tickMs: 10_000,
      sample: async () => fake(1),
      log,
    });
    await recorder.booted;
    recorder.stop();
    expect(log).not.toHaveBeenCalled();
  });

  it('samples only every 15th tick while idle', async () => {
    const sample = vi.fn(async () => fake(1));
    const recorder = startNativeFlightRecorder({
      isBusy: () => false,
      dir,
      tickMs: 5,
      sample,
      log: vi.fn(),
    });
    await recorder.booted;
    await wait(140);
    recorder.stop();
    const ticks = Math.floor(140 / 5);
    expect(sample.mock.calls.length).toBeLessThanOrEqual(Math.ceil(ticks / 15) + 1);
  });

  it('never lets sampling or a missing mount escape', async () => {
    const recorder = startNativeFlightRecorder({
      isBusy: () => true,
      dir: join(dir, 'missing-parent', 'flight'),
      tickMs: 5,
      sample: async () => {
        throw new Error('boom');
      },
      log: vi.fn(),
    });
    await recorder.booted;
    await wait(30);
    recorder.stop();
    await expect(fs.stat(join(dir, 'missing-parent'))).rejects.toThrow();
  });
});
