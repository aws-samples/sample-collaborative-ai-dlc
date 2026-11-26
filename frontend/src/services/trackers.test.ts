import { describe, it, expect, vi } from 'vitest';

const get = vi.fn();
vi.mock('./api', () => ({
  api: { get: (...a: unknown[]) => get(...a) },
  ApiError: class ApiError extends Error {},
}));

import { trackersService } from './trackers';

const issue = (resourceId: string) => ({
  resourceId,
  resourceUrl: `https://example.atlassian.net/browse/${resourceId}`,
  resourceType: 'issue',
  title: resourceId,
});

describe('trackersService.listIssuePages', () => {
  it('skips an issue an earlier page already listed', async () => {
    get
      .mockResolvedValueOnce({
        items: [issue('PROJ-7'), issue('PROJ-9')],
        hasNext: true,
        nextPageToken: 't2',
        totalCount: null,
      })
      .mockResolvedValueOnce({
        items: [issue('PROJ-3'), issue('PROJ-7')],
        hasNext: false,
        nextPageToken: null,
        totalCount: null,
      });

    const pages = [];
    for await (const page of trackersService.listIssuePages('p-dedupe', 'b1', 'open', 'PROJ-7')) {
      pages.push(page.items.map((i) => i.resourceId));
    }

    expect(pages).toEqual([['PROJ-7', 'PROJ-9'], ['PROJ-3']]);
  });

  it('yields nothing for a request aborted while in flight', async () => {
    const controller = new AbortController();
    get.mockImplementationOnce(async () => {
      controller.abort();
      return { items: [], hasNext: false, nextPageToken: null, totalCount: null };
    });
    const iter = trackersService.listIssuePages('p1', 'b1', 'open', 'x', 30, controller.signal);
    expect(await iter.next()).toEqual({ value: undefined, done: true });
  });
});

describe('trackersService.listComments', () => {
  const comment = (id: string) => ({ id, body: id });

  it('reads the discussion one page per request', async () => {
    get.mockReset();
    get
      .mockResolvedValueOnce({ comments: [comment('1')], nextPage: 2 })
      .mockResolvedValueOnce({ comments: [comment('101')], nextPage: null });

    const comments = await trackersService.listComments('p1', 'b1', '42');

    expect(comments.map((c) => c.id)).toEqual(['1', '101']);
    expect(get.mock.calls.map(([path]) => path)).toEqual([
      '/projects/p1/trackers/b1/issues/42/comments?page=1',
      '/projects/p1/trackers/b1/issues/42/comments?page=2',
    ]);
  });

  it('keeps the comments already read when a later page fails', async () => {
    get.mockReset();
    get
      .mockResolvedValueOnce({ comments: [comment('1')], nextPage: 2 })
      .mockRejectedValueOnce(new Error('Gateway Timeout'));

    expect((await trackersService.listComments('p1', 'b1', '42')).map((c) => c.id)).toEqual(['1']);
  });

  it('fails when page 1 fails, so the caller falls back to no comments', async () => {
    get.mockReset();
    get.mockRejectedValueOnce(new Error('Gateway Timeout'));

    await expect(trackersService.listComments('p1', 'b1', '42')).rejects.toThrow('Gateway Timeout');
  });
});
