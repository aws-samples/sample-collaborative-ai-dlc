import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { scrollToReference } from '@/components/layout/scrollToReference';

const ANCHOR = 'ref-unit-of-work--u26';

function containerWithRow(): { container: HTMLElement; row: HTMLElement } {
  const container = document.createElement('div');
  const row = document.createElement('tr');
  row.id = ANCHOR;
  row.scrollIntoView = vi.fn();
  container.append(row);
  return { container, row };
}

describe('scrollToReference', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('scrolls to and flashes the anchored element, then reports done once', () => {
    const { container, row } = containerWithRow();
    const done = vi.fn();

    scrollToReference(() => container, ANCHOR, done);

    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(row.classList.contains('bg-primary/10')).toBe(true);
    expect(done).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1600);
    expect(row.classList.contains('bg-primary/10')).toBe(false);
  });

  it('reads the container again on each retry, so content that mounts late is found', () => {
    const { container, row } = containerWithRow();
    let mounted: HTMLElement | null = null;
    const done = vi.fn();

    scrollToReference(() => mounted, ANCHOR, done);
    expect(done).not.toHaveBeenCalled();

    mounted = container;
    vi.advanceTimersByTime(80);

    expect(row.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(done).toHaveBeenCalledTimes(1);
  });

  it('gives up after its retries and still reports done', () => {
    const done = vi.fn();

    scrollToReference(() => document.createElement('div'), ANCHOR, done);
    vi.advanceTimersByTime(80 * 9);
    expect(done).not.toHaveBeenCalled();
    vi.advanceTimersByTime(80);

    expect(done).toHaveBeenCalledTimes(1);
  });
});
