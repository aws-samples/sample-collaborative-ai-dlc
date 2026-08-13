import { describe, expect, it } from 'vitest';
import { mapWithConcurrency } from '../concurrency.js';

describe('mapWithConcurrency', () => {
  it('bounds concurrent work and preserves input order', async () => {
    let active = 0;
    let peak = 0;
    const releases = [];

    const pending = mapWithConcurrency([3, 1, 2], 2, async (value, index) => {
      active += 1;
      peak = Math.max(peak, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      return `${index}:${value}`;
    });

    await Promise.resolve();
    expect(active).toBe(2);
    releases.shift()();
    await Promise.resolve();
    releases.shift()();
    await Promise.resolve();
    releases.shift()();

    await expect(pending).resolves.toEqual(['0:3', '1:1', '2:2']);
    expect(peak).toBe(2);
  });

  it('returns an empty result without invoking the worker', async () => {
    let invoked = false;
    await expect(
      mapWithConcurrency([], 2, async () => {
        invoked = true;
      }),
    ).resolves.toEqual([]);
    expect(invoked).toBe(false);
  });
});
