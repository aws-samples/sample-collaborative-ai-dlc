// One provider page per request on the IAM-only operate path that the
// trackers comments route and the base branch picker reach. Only repository
// and credential reads and the HTTP transport are stubbed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const chain = () =>
  new Proxy(
    {},
    {
      get: (_target, prop) => {
        if (prop === 'then') return undefined;
        if (prop === 'toList') return async () => [{ provider: 'github', repo: 'owner/api' }];
        return chain;
      },
    },
  );
vi.mock('gremlin', () => ({
  default: {
    process: {
      AnonymousTraversalSource: { traversal: () => ({ withRemote: chain }) },
      statics: chain(),
    },
    driver: {
      DriverRemoteConnection: class {
        async close() {}
      },
    },
  },
}));
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({}),
}));
vi.mock('gremlin-aws-sigv4/lib/utils.js', () => ({
  getUrlAndHeaders: () => ({ url: 'wss://neptune.invalid/gremlin', headers: {} }),
}));
vi.mock('../../shared/source-control-credentials.js', () => ({
  resolveBindingCredential: async () => ({ token: 'test' }),
  verifyBindingCredential: vi.fn(),
}));
const { handler } = await import('../index.js');

// A GitHub list of `total` rows served 100 per page with a Link header.
const githubList = (pathSuffix, total, row) => {
  const calls = [];
  const fetchImpl = async (url) => {
    const parsed = new URL(url);
    if (!parsed.pathname.endsWith(pathSuffix)) {
      return new Response(JSON.stringify({ default_branch: 'main' }), { status: 200 });
    }
    const page = Number(parsed.searchParams.get('page'));
    calls.push(page);
    const rows = [];
    for (let n = (page - 1) * 100 + 1; n <= Math.min(page * 100, total); n += 1) rows.push(row(n));
    const headers = page * 100 < total ? { link: `<${url}>; rel="next"` } : {};
    return new Response(JSON.stringify(rows), { status: 200, headers });
  };
  return { calls, fetchImpl };
};

const operate = (operation, args) => ({
  action: 'operate',
  projectId: 'project',
  provider: 'github',
  repo: 'owner/api',
  operation,
  args,
});

describe('source-control list pages', () => {
  beforeEach(() => {
    vi.spyOn(DynamoDBDocumentClient.prototype, 'send').mockResolvedValue({
      Item: {
        projectId: 'project',
        provider: 'github',
        repo: 'owner/api',
        authType: 'github-oauth',
        status: 'active',
      },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('reads one page of issue comments per request, so page 2 holds comment 101', async () => {
    const list = githubList('/issues/7/comments', 150, (n) => ({
      id: n,
      body: `c${n}`,
      user: { login: 'alice' },
    }));
    vi.stubGlobal('fetch', list.fetchImpl);

    const first = await handler(operate('list-issue-comments', { number: 7, page: 1 }));
    expect(first.ok).toBe(true);
    expect(first.result.comments).toHaveLength(100);
    expect(first.result.nextPage).toBe(2);
    const second = await handler(operate('list-issue-comments', { number: 7, page: 2 }));
    expect(second.result.comments[0].body).toBe('c101');
    expect(second.result.nextPage).toBeNull();
    expect(list.calls).toEqual([1, 2]);
  });

  it('still reads the whole discussion for a caller that does not page', async () => {
    const list = githubList('/issues/7/comments', 150, (n) => ({
      id: n,
      body: `c${n}`,
      user: { login: 'alice' },
    }));
    vi.stubGlobal('fetch', list.fetchImpl);

    const all = await handler(operate('list-issue-comments', { number: 7 }));
    expect(all.result).toHaveLength(150);
    expect(list.calls).toEqual([1, 2]);
  });

  it('reads one page of branches and looks up the default branch only on page 1', async () => {
    const list = githubList('/branches', 250, (n) => ({ name: `b${n}` }));
    const defaultLookups = [];
    vi.stubGlobal('fetch', (url, options) => {
      if (new URL(url).pathname === '/repos/owner/api') defaultLookups.push(url);
      return list.fetchImpl(url, options);
    });

    const first = await handler(operate('branches', { page: 1 }));
    expect(first.result).toMatchObject({ nextPage: 2, defaultBranch: 'main' });
    expect(first.result.branches).toHaveLength(100);
    const last = await handler(operate('branches', { page: '3' }));
    expect(last.result).toEqual({
      branches: Array.from({ length: 50 }, (_, i) => `b${i + 201}`),
      nextPage: null,
    });
    expect(list.calls).toEqual([1, 3]);
    expect(defaultLookups).toHaveLength(1);
  });

  it('keeps the unpaged branch answer for callers that send no page', async () => {
    const list = githubList('/branches', 2, (n) => ({ name: `b${n}` }));
    vi.stubGlobal('fetch', list.fetchImpl);

    const res = await handler(operate('branches', {}));
    expect(res.result).toEqual({ branches: ['b1', 'b2'], defaultBranch: 'main' });
  });
});
