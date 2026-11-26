import { describe, it, expect, vi } from 'vitest';
import { collectListPages, readListPages } from './pagination';

const pages = (count: number) =>
  vi.fn(async (page: number) => ({ rows: [page], nextPage: page < count ? page + 1 : null }));

describe('readListPages', () => {
  it('asks for one page per request, in order, until there is no next page', async () => {
    const fetchPage = pages(3);
    const seen = [];
    for await (const page of readListPages(fetchPage)) seen.push(page);

    expect(fetchPage.mock.calls).toEqual([[1], [2], [3]]);
    expect(seen).toEqual([
      { rows: [1], done: false },
      { rows: [2], done: false },
      { rows: [3], done: true },
    ]);
  });

  it('stops at the cap with the last page not done', async () => {
    const fetchPage = pages(50);
    const seen = [];
    for await (const page of readListPages(fetchPage, 4)) seen.push(page);

    expect(fetchPage).toHaveBeenCalledTimes(4);
    expect(seen.at(-1)).toEqual({ rows: [4], done: false });
  });

  it('treats an answer without nextPage, from a server that predates paging, as the last page', async () => {
    const fetchPage = vi.fn(async () => ({ rows: ['a', 'b'] }));
    const seen = [];
    for await (const page of readListPages(fetchPage)) seen.push(page);

    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(seen).toEqual([{ rows: ['a', 'b'], done: true }]);
  });
});

describe('collectListPages', () => {
  it('waits for each page before asking for the next, so one slow page delays only itself', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const fetchPage = vi.fn(async (page: number) => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((resolve) => setTimeout(resolve, page === 2 ? 20 : 1));
      inFlight -= 1;
      return { rows: [page], nextPage: page < 3 ? page + 1 : null };
    });

    expect(await collectListPages(fetchPage)).toEqual({ rows: [1, 2, 3], complete: true });
    expect(maxInFlight).toBe(1);
  });

  it('throws when page 1 fails', async () => {
    await expect(
      collectListPages(async () => Promise.reject(new Error('Not connected'))),
    ).rejects.toThrow('Not connected');
  });

  it('keeps the rows already read when a later page fails', async () => {
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 2) throw new Error('API rate limit exceeded');
      return { rows: [page], nextPage: page + 1 };
    });

    expect(await collectListPages(fetchPage)).toEqual({ rows: [1], complete: false });
  });

  it('keeps an empty first page when a later page fails', async () => {
    const fetchPage = vi.fn(async (page: number) => {
      if (page === 2) throw new Error('timeout');
      return { rows: [], nextPage: 2 };
    });

    expect(await collectListPages(fetchPage)).toEqual({ rows: [], complete: false });
  });

  it('reports a capped list as incomplete', async () => {
    expect(await collectListPages(pages(20), 2)).toEqual({ rows: [1, 2], complete: false });
  });
});
