import { describe, expect, it, vi } from 'vitest';
import { Suspense } from 'react';
import { render, screen } from '@/test/query';
import { lazyWithPreload } from './lazyWithPreload';

function Page() {
  return <p>Loaded page</p>;
}

describe('lazyWithPreload', () => {
  it('preload imports once and the lazy render reuses it', async () => {
    const factory = vi.fn().mockResolvedValue({ default: Page });
    const LazyPage = lazyWithPreload(factory);
    const first = LazyPage.preload();
    const second = LazyPage.preload();
    expect(first).toBe(second);
    await first;

    render(
      <Suspense fallback={<p>waiting</p>}>
        <LazyPage />
      </Suspense>,
    );
    expect(await screen.findByText('Loaded page')).toBeInTheDocument();
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it('a failed preload resets so a later attempt retries', async () => {
    const factory = vi
      .fn()
      .mockRejectedValueOnce(new Error('chunk failed'))
      .mockResolvedValue({ default: Page });
    const LazyPage = lazyWithPreload(factory);
    await expect(LazyPage.preload()).rejects.toThrow('chunk failed');
    await expect(LazyPage.preload()).resolves.toEqual({ default: Page });
    expect(factory).toHaveBeenCalledTimes(2);
  });
});
