import { describe, it, expect } from 'vitest';
import {
  makeSemaphore,
  makeMergeLock,
  parseChoice,
  validateFanoutOverrides,
  unitBranchFor,
  laneSessionIdFor,
} from '../section.js';

const tick = () => new Promise((r) => setTimeout(r, 0));

describe('makeSemaphore (maxParallelUnits)', () => {
  it('caps concurrency at the limit and admits waiters as permits free', async () => {
    const sem = makeSemaphore(2);
    let active = 0;
    let peak = 0;
    const task = async () => {
      await sem.acquire();
      active += 1;
      peak = Math.max(peak, active);
      await tick();
      active -= 1;
      sem.release();
    };
    await Promise.all([task(), task(), task(), task(), task()]);
    expect(peak).toBe(2);
  });

  it('0 / null / undefined = unbounded (the DAG is the only limit)', async () => {
    for (const limit of [0, null, undefined, -1]) {
      const sem = makeSemaphore(limit);
      let active = 0;
      let peak = 0;
      await Promise.all(
        [1, 2, 3].map(async () => {
          await sem.acquire();
          active += 1;
          peak = Math.max(peak, active);
          await tick();
          active -= 1;
          sem.release();
        }),
      );
      expect(peak).toBe(3);
    }
  });
});

describe('makeMergeLock (serialized merge-back)', () => {
  it('serializes concurrent merges in submission order', async () => {
    const lock = makeMergeLock();
    const order = [];
    const merge = (name, delay) =>
      lock(async () => {
        order.push(`start:${name}`);
        await new Promise((r) => setTimeout(r, delay));
        order.push(`end:${name}`);
        return name;
      });
    const [a, b] = await Promise.all([merge('a', 10), merge('b', 0)]);
    expect(a).toBe('a');
    expect(b).toBe('b');
    // b never starts before a ends — no interleaving.
    expect(order).toEqual(['start:a', 'end:a', 'start:b', 'end:b']);
  });

  it('a failed merge does not poison the chain (failure is a value upstream)', async () => {
    const lock = makeMergeLock();
    await expect(
      lock(async () => {
        throw new Error('merge exploded');
      }),
    ).rejects.toThrow('merge exploded');
    // The next merge still runs.
    await expect(lock(async () => 'ok')).resolves.toBe('ok');
  });
});

describe('parseChoice (gate answers, never trusted blindly)', () => {
  it('accepts the shapes the answer endpoint stores', () => {
    const allowed = ['retry', 'skip', 'abort'];
    expect(parseChoice({ decision: 'retry' }, allowed)).toBe('retry');
    expect(parseChoice({ mode: 'Skip' }, allowed)).toBe('skip');
    expect(parseChoice({ choice: 'ABORT' }, allowed)).toBe('abort');
    expect(parseChoice('retry', allowed)).toBe('retry');
    expect(parseChoice({ freeText: ' abort ' }, allowed)).toBe('abort');
  });

  it('returns null for anything unrecognized (caller picks the safe fallback)', () => {
    const allowed = ['autonomous', 'gated'];
    expect(parseChoice(null, allowed)).toBeNull();
    expect(parseChoice({}, allowed)).toBeNull();
    expect(parseChoice({ decision: 'yolo' }, allowed)).toBeNull();
    expect(parseChoice({ freeText: 'do whatever' }, allowed)).toBeNull();
    expect(parseChoice(42, allowed)).toBeNull();
  });
});

describe('validateFanoutOverrides', () => {
  const bySlug = new Map([
    ['auth', { slug: 'auth', dependsOn: [] }],
    ['billing', { slug: 'billing', dependsOn: ['auth'] }],
  ]);
  const args = {
    slugs: new Set(['auth', 'billing']),
    sectionStages: [
      { stageId: 'fd', execution: 'CONDITIONAL' },
      { stageId: 'cg', execution: 'ALWAYS' },
    ],
    bySlug,
  };

  it('accepts a dependency-free skeleton and CONDITIONAL skips only', () => {
    const out = validateFanoutOverrides(
      { walkingSkeleton: 'auth', skipMatrix: { billing: ['fd'] } },
      args,
    );
    expect(out.walkingSkeleton).toBe('auth');
    expect(out.skipMatrix).toEqual({ billing: ['fd'] });
    expect(out.rejected).toEqual([]);
  });

  it('rejects a dependent skeleton, unknown units, non-CONDITIONAL and unknown stages', () => {
    const out = validateFanoutOverrides(
      {
        walkingSkeleton: 'billing',
        skipMatrix: { auth: ['cg', 'nope'], ghost: ['fd'] },
      },
      args,
    );
    expect(out.walkingSkeleton).toBeUndefined();
    expect(out.skipMatrix).toEqual({ auth: [] });
    expect(out.rejected).toHaveLength(4);
    expect(out.rejected.join('; ')).toContain('dependency-free');
    expect(out.rejected.join('; ')).toContain('ghost');
  });

  it('tolerates a null / non-object / empty answer (defaults apply)', () => {
    expect(validateFanoutOverrides(null, args).rejected).toEqual([]);
    expect(validateFanoutOverrides('approved', args).rejected).toEqual([]);
    expect(validateFanoutOverrides({}, args)).toEqual({ rejected: [] });
  });
});

describe('lane naming (A2 rules 3 + 6)', () => {
  it('unit branches are per-section off the intent branch', () => {
    expect(unitBranchFor('aidlc/i1', 1, 'auth')).toBe('aidlc/i1--s1-unit-auth');
    expect(unitBranchFor('aidlc/i1', 2, 'auth')).toBe('aidlc/i1--s2-unit-auth');
  });

  it('lane sessions are per (intent, section, unit) and satisfy the 33-char minimum', () => {
    const id = laneSessionIdFor('i1', 1, 'auth');
    expect(id.startsWith('aidlc-intent-i1-s1-auth')).toBe(true);
    expect(id.length).toBeGreaterThanOrEqual(33);
    expect(laneSessionIdFor('i1', 1, 'billing')).not.toBe(id);
    expect(laneSessionIdFor('i1', 2, 'auth')).not.toBe(id);
  });
});
