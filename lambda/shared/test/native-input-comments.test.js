import { expect, it, vi } from 'vitest';
import { getProvider } from '../git-providers.js';
it.each(['github', 'gitlab'])(
  'uses complete bounded %s discussions for both text and attachment discovery',
  async (provider) => {
    const fetchImpl = vi.fn(async (url) => {
      const target = new URL(url);
      if (target.pathname.endsWith('/issues/7'))
        return Response.json({ number: 7, iid: 7, title: 'Issue', body: '', description: '' });
      const page = target.searchParams.get('page');
      return Response.json(
        [{ id: page, body: `page ${page}`, user: { login: 'a' }, author: { username: 'a' } }],
        {
          headers:
            page === '1'
              ? provider === 'github'
                ? { link: '<https://api.github.com/untrusted>; rel="next"' }
                : { 'x-next-page': '2' }
              : {},
        },
      );
    });
    const adapter = getProvider(provider);
    expect(
      await adapter.listIssueComments({ token: 'fixture', fetchImpl }, 'owner/repo', 7, {
        complete: true,
      }),
    ).toMatchObject([{ body: 'page 1' }, { body: 'page 2' }]);
    expect(fetchImpl.mock.calls.every(([url]) => !url.includes('untrusted'))).toBe(true);
    fetchImpl.mockClear();
    expect(
      await adapter.issueAttachments({ token: 'fixture', fetchImpl }, 'owner/repo', { number: 7 }),
    ).toEqual({ attachments: [] });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    fetchImpl.mockImplementation(async () =>
      Response.json([{ id: '1', body: 'x' }], {
        headers:
          provider === 'github' ? { link: '<ignored>; rel="next"' } : { 'x-next-page': '100' },
      }),
    );
    await expect(
      adapter.listIssueComments({ token: 'fixture', fetchImpl }, 'owner/repo', 7, {
        complete: true,
      }),
    ).rejects.toThrow();
  },
);
