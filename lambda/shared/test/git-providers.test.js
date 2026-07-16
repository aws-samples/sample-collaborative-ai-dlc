import { describe, it, expect, vi } from 'vitest';
import {
  getProvider,
  buildCloneUrl,
  gitHost,
  normalizeProviderId,
  isKnownProvider,
  KNOWN_PROVIDERS,
  ProviderError,
} from '../git-providers.js';

// A minimal fetch double: queue responses keyed by a substring of the URL.
const makeFetch = (handlers) => {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    for (const [match, resp] of handlers) {
      if (url.includes(match)) {
        const r = typeof resp === 'function' ? resp(url, options) : resp;
        return {
          ok: r.ok ?? (r.status ? r.status < 400 : true),
          status: r.status ?? 200,
          json: async () => r.json,
          text: async () => (typeof r.text === 'string' ? r.text : JSON.stringify(r.json ?? '')),
          headers: { get: () => null },
        };
      }
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };
  fetchImpl.calls = calls;
  return fetchImpl;
};

describe('git-providers registry', () => {
  it('lists github and gitlab', () => {
    expect(KNOWN_PROVIDERS).toEqual(expect.arrayContaining(['github', 'gitlab']));
  });

  it('defaults undefined/empty provider to github', () => {
    expect(normalizeProviderId(undefined)).toBe('github');
    expect(normalizeProviderId('')).toBe('github');
    expect(getProvider(undefined).id).toBe('github');
  });

  it('isKnownProvider treats undefined as the default (github)', () => {
    expect(isKnownProvider(undefined)).toBe(true);
    expect(isKnownProvider('gitlab')).toBe(true);
    expect(isKnownProvider('bitbucket')).toBe(false);
  });

  it('throws ProviderError for an unknown provider', () => {
    expect(() => getProvider('bitbucket')).toThrow(ProviderError);
  });
});

describe('clone URL + host plumbing', () => {
  it('builds a tokenized GitHub clone URL with x-access-token', () => {
    expect(buildCloneUrl('github', 'owner/repo', 'TKN')).toBe(
      'https://x-access-token:TKN@github.com/owner/repo.git',
    );
    expect(gitHost('github')).toBe('github.com');
  });

  it('builds a tokenized GitLab clone URL with oauth2 scheme', () => {
    expect(buildCloneUrl('gitlab', 'group/project', 'TKN')).toBe(
      'https://oauth2:TKN@gitlab.com/group/project.git',
    );
    expect(gitHost('gitlab')).toBe('gitlab.com');
  });

  it('omits auth when no token is supplied', () => {
    expect(buildCloneUrl('github', 'o/r', '')).toBe('https://github.com/o/r.git');
    expect(buildCloneUrl('gitlab', 'g/p', '')).toBe('https://gitlab.com/g/p.git');
  });
});

describe('github provider — repo browse + PR + comments', () => {
  const gh = getProvider('github');

  it('maps repos to the unified DTO', async () => {
    const fetchImpl = makeFetch([
      [
        '/user/repos',
        {
          json: [{ id: 1, name: 'r', full_name: 'o/r', private: true, default_branch: 'main' }],
        },
      ],
    ]);
    const repos = await gh.listRepos({ token: 't', fetchImpl });
    expect(repos).toEqual([
      { id: 1, name: 'r', fullName: 'o/r', private: true, defaultBranch: 'main' },
    ]);
  });

  it('getAuthenticatedUser uses the PUBLIC email when present', async () => {
    const fetchImpl = makeFetch([
      ['/user', { json: { login: 'janedev', id: 123, name: 'Jane Dev', email: 'jane@corp.com' } }],
    ]);
    const user = await gh.getAuthenticatedUser({ token: 't', fetchImpl });
    expect(user).toEqual({
      login: 'janedev',
      authorName: 'Jane Dev',
      authorEmail: 'jane@corp.com',
    });
  });

  it('getAuthenticatedUser falls back to the noreply address (private email) and login (no name)', async () => {
    const fetchImpl = makeFetch([
      ['/user', { json: { login: 'janedev', id: 123, name: null, email: null } }],
    ]);
    const user = await gh.getAuthenticatedUser({ token: 't', fetchImpl });
    expect(user).toEqual({
      login: 'janedev',
      authorName: 'janedev',
      authorEmail: '123+janedev@users.noreply.github.com',
    });
  });

  it('getAuthenticatedUser throws ProviderError on an API failure', async () => {
    const fetchImpl = makeFetch([['/user', { status: 401, json: { message: 'Bad credentials' } }]]);
    await expect(gh.getAuthenticatedUser({ token: 't', fetchImpl })).rejects.toThrow(
      'Bad credentials',
    );
  });

  it('createPullRequest returns prUrl/prNumber on success', async () => {
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [] }],
      [
        '/pulls',
        (url, opts) =>
          opts.method === 'POST'
            ? { status: 201, json: { html_url: 'https://gh/pr/7', number: 7 } }
            : { json: [] },
      ],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ prUrl: 'https://gh/pr/7', prNumber: 7 });
  });

  it('creates a draft with provider metadata and recovers only an exact open PR', async () => {
    let posts = 0;
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [] }],
      [
        '/pulls?head=o:unit%2Fauth&state=open',
        {
          json: [
            {
              id: 'PR_existing',
              number: 9,
              html_url: 'https://gh/pr/9',
              head: { ref: 'unit/auth', sha: 'head-9' },
              base: { ref: 'intent', sha: 'base-9' },
              draft: true,
            },
          ],
        },
      ],
      [
        '/repos/o/r/pulls',
        (_url, options) => {
          if (options.method !== 'POST') return { json: [] };
          posts += 1;
          return {
            status: 422,
            text: JSON.stringify({ message: 'A pull request already exists' }),
          };
        },
      ],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'unit/auth',
      baseBranch: 'intent',
      title: 'Auth',
      body: 'Review',
      draft: true,
    });
    expect(posts).toBe(1);
    expect(out).toEqual({
      prUrl: 'https://gh/pr/9',
      prNumber: 9,
      existing: true,
      providerId: 'PR_existing',
      headSha: 'head-9',
      targetSha: 'base-9',
      draft: true,
    });
  });

  it('supports exact lookup, status, draft transitions, reopen, and ancestry', async () => {
    let draft = true;
    let state = 'open';
    const fetchImpl = makeFetch([
      [
        '/pulls?head=o:unit%2Fauth&state=open',
        {
          json: [
            {
              id: 'PR_7',
              number: 7,
              head: { ref: 'unit/auth', sha: 'head-7' },
              base: { ref: 'intent', sha: 'base-7' },
            },
            {
              id: 'PR_wrong',
              number: 8,
              head: { ref: 'unit/auth', sha: 'head-8' },
              base: { ref: 'other', sha: 'base-8' },
            },
          ],
        },
      ],
      [
        '/pulls/7',
        (_url, options) => {
          if (options.method === 'PATCH') state = 'open';
          return {
            json: {
              id: 'PR_7',
              number: 7,
              html_url: 'https://gh/pr/7',
              head: { ref: 'unit/auth', sha: 'head-7' },
              base: { ref: 'intent', sha: 'base-7' },
              state,
              draft,
              mergeable: true,
              mergeable_state: 'clean',
            },
          };
        },
      ],
      [
        '/graphql',
        (_url, options) => {
          const query = JSON.parse(options.body).query;
          draft = query.includes('convertPullRequestToDraft');
          return { json: { data: { pullRequest: { id: 'PR_7' } } } };
        },
      ],
      ['/compare/head-7...intent', { json: { status: 'ahead' } }],
    ]);
    const found = await gh.findPullRequest({ token: 't', fetchImpl }, 'o/r', {
      sourceBranch: 'unit/auth',
      targetBranch: 'intent',
      state: 'open',
    });
    expect(found.number).toBe(7);
    expect(await gh.getPullRequestStatus({ token: 't', fetchImpl }, 'o/r', 7)).toMatchObject({
      state: 'open',
      draft: true,
      headSha: 'head-7',
      targetSha: 'base-7',
      mergeable: true,
    });
    expect(await gh.setPullRequestDraft({ token: 't', fetchImpl }, 'o/r', 7, false)).toMatchObject({
      state: 'open',
      draft: false,
    });
    state = 'closed';
    expect(await gh.reopenPullRequest({ token: 't', fetchImpl }, 'o/r', 7)).toMatchObject({
      state: 'open',
    });
    expect(await gh.isCommitAncestor({ token: 't', fetchImpl }, 'o/r', 'head-7', 'intent')).toBe(
      true,
    );
  });

  it('paginates general and inline review comments with bot attribution', async () => {
    const page = (url, type) => {
      const pageNumber = Number(new URL(url).searchParams.get('page'));
      if (pageNumber > 1) return { json: [] };
      return {
        json: Array.from({ length: 100 }, (_, index) => ({
          id: `${type}-${index}`,
          body: `comment ${index}`,
          user: { login: index === 0 ? 'ci[bot]' : 'reviewer', type: index === 0 ? 'Bot' : 'User' },
          created_at: '2026-01-01T00:00:00Z',
          updated_at: '2026-01-01T00:01:00Z',
        })),
      };
    };
    const fetchImpl = makeFetch([
      ['/pulls/7/comments', (url) => page(url, 'review')],
      ['/issues/7/comments', (url) => page(url, 'issue')],
    ]);
    const comments = await gh.listPRComments({ token: 't', fetchImpl }, 'o/r', 7);
    expect(comments).toHaveLength(200);
    expect(comments.filter((comment) => comment.bot)).toHaveLength(2);
    expect(fetchImpl.calls.some((call) => call.url.includes('page=2'))).toBe(true);
  });

  it('createPullRequest reports conflict when task branches are unmerged', async () => {
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [{ ref: 'refs/heads/feat--task-1' }] }],
      ['/compare/', { json: { status: 'diverged' } }],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out.conflict).toBe(true);
    expect(out.unmergedBranches).toEqual(['feat--task-1']);
  });

  it('createPullRequest retargets the repo default branch on a base-invalid 422', async () => {
    // Repo has no `main` (default is `master`); the first POST 422s on base,
    // no existing PR is found, and the retry against the resolved default wins.
    let posts = 0;
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [] }],
      // Bare repo GET — must be listed before /pulls so the substring match is
      // unambiguous (this URL does not contain `/pulls`).
      [
        '/repos/o/r/pulls',
        (url, opts) => {
          if (opts.method !== 'POST') return { json: [] }; // findPRByBranch → none
          posts += 1;
          return posts === 1
            ? {
                status: 422,
                text: JSON.stringify({
                  errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }],
                }),
              }
            : { status: 201, json: { html_url: 'https://gh/pr/9', number: 9 } };
        },
      ],
      ['/repos/o/r', { json: { default_branch: 'master' } }],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ prUrl: 'https://gh/pr/9', prNumber: 9, retargetedBase: 'master' });
    expect(posts).toBe(2);
  });

  it('createPullRequest resolves the repo default branch when baseBranch is omitted', async () => {
    // No baseBranch on the call (per-repo baseBranches map left this repo
    // unset) — must target the repo's REAL default, not a hardcoded 'main'.
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [] }],
      ['/repos/o/r/pulls', { status: 201, json: { html_url: 'https://gh/pr/5', number: 5 } }],
      ['/repos/o/r', { json: { default_branch: 'develop' } }],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'feat',
      baseBranch: null,
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ prUrl: 'https://gh/pr/5', prNumber: 5 });
    const postCall = fetchImpl.calls.find((c) => c.options?.method === 'POST');
    expect(JSON.parse(postCall.options.body).base).toBe('develop');
  });

  // ── 422 classification (2026-07 incident: a never-pushed head must NOT be
  // reported as a benign "no changes" skip) ─────────────────────────────────

  it('createPullRequest classifies a genuine "no commits between" 422 as skipped/no_changes', async () => {
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [] }],
      [
        '/repos/o/r/pulls',
        (url, opts) =>
          opts.method === 'POST'
            ? {
                status: 422,
                text: JSON.stringify({
                  message: 'Validation Failed',
                  errors: [{ message: 'No commits between main and feat' }],
                }),
              }
            : { json: [] }, // findPRByBranch → none
      ],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ skipped: true, reason: 'no_changes' });
  });

  it('createPullRequest classifies a missing-head 422 as FAILED head_missing, never a skip', async () => {
    const fetchImpl = makeFetch([
      ['/git/matching-refs/', { json: [] }],
      [
        '/repos/o/r/pulls',
        (url, opts) =>
          opts.method === 'POST'
            ? {
                status: 422,
                text: JSON.stringify({
                  message: 'Validation Failed',
                  errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
                }),
              }
            : { json: [] },
      ],
    ]);
    const out = await gh.createPullRequest({ token: 't', fetchImpl }, 'o/r', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out.failed).toBe(true);
    expect(out.reason).toBe('head_missing');
    expect(out.error).toContain('never pushed');
    expect(out.skipped).toBeUndefined();
  });

  // ── compareBranches — the PR fan-in pre-check ─────────────────────────────

  it('compareBranches maps ahead/identical from the compare API', async () => {
    const ahead = makeFetch([['/compare/main...feat', { json: { status: 'ahead', ahead_by: 2 } }]]);
    expect(
      await gh.compareBranches({ token: 't', fetchImpl: ahead }, 'o/r', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'ahead', aheadBy: 2, base: 'main' });
    const identical = makeFetch([
      ['/compare/main...feat', { json: { status: 'identical', ahead_by: 0 } }],
    ]);
    expect(
      await gh.compareBranches({ token: 't', fetchImpl: identical }, 'o/r', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'identical', aheadBy: 0, base: 'main' });
  });

  it('compareBranches distinguishes a missing head from a missing base on a compare 404', async () => {
    const headGone = makeFetch([
      ['/compare/', { status: 404, json: { message: 'Not Found' } }],
      ['/git/ref/heads/feat', { status: 404, json: { message: 'Not Found' } }],
    ]);
    expect(
      await gh.compareBranches({ token: 't', fetchImpl: headGone }, 'o/r', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'missing_head', base: 'main' });
    const baseGone = makeFetch([
      ['/compare/', { status: 404, json: { message: 'Not Found' } }],
      ['/git/ref/heads/feat', { json: { ref: 'refs/heads/feat' } }],
    ]);
    expect(
      await gh.compareBranches({ token: 't', fetchImpl: baseGone }, 'o/r', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'missing_base', base: 'main' });
  });

  it('compareBranches resolves the repo default branch when base is omitted and reports unknown on API trouble', async () => {
    const fetchImpl = makeFetch([
      ['/compare/develop...feat', { json: { status: 'ahead', ahead_by: 1 } }],
      ['/repos/o/r', { json: { default_branch: 'develop' } }],
    ]);
    expect(
      await gh.compareBranches({ token: 't', fetchImpl }, 'o/r', { base: null, head: 'feat' }),
    ).toEqual({ status: 'ahead', aheadBy: 1, base: 'develop' });
    const broken = makeFetch([['/compare/', { status: 500, json: {} }]]);
    expect(
      (
        await gh.compareBranches({ token: 't', fetchImpl: broken }, 'o/r', {
          base: 'main',
          head: 'feat',
        })
      ).status,
    ).toBe('unknown');
  });

  it('getPullRequestState classifies merged vs closed vs open', async () => {
    const open = makeFetch([['/pulls/1', { json: { state: 'open' } }]]);
    const merged = makeFetch([['/pulls/2', { json: { state: 'closed', merged_at: 'x' } }]]);
    const closed = makeFetch([['/pulls/3', { json: { state: 'closed', merged_at: null } }]]);
    expect(await gh.getPullRequestState({ token: 't', fetchImpl: open }, 'o/r', 1)).toBe('open');
    expect(await gh.getPullRequestState({ token: 't', fetchImpl: merged }, 'o/r', 2)).toBe(
      'merged',
    );
    expect(await gh.getPullRequestState({ token: 't', fetchImpl: closed }, 'o/r', 3)).toBe(
      'closed',
    );
  });

  it('mergeBranch maps 201/409/other', async () => {
    const ok = makeFetch([['/merges', { status: 201, json: {} }]]);
    const conflict = makeFetch([['/merges', { status: 409, json: {} }]]);
    expect(
      await gh.mergeBranch({ token: 't', fetchImpl: ok }, 'o/r', { base: 'm', head: 'h' }),
    ).toBe('merged');
    expect(
      await gh.mergeBranch({ token: 't', fetchImpl: conflict }, 'o/r', { base: 'm', head: 'h' }),
    ).toBe('conflict');
  });

  it('rejects malformed repo references', async () => {
    await expect(
      gh.listBranches({ token: 't', fetchImpl: makeFetch([]) }, 'no-slash'),
    ).rejects.toThrow(ProviderError);
  });
});

describe('gitlab provider — repo browse + MR + token refresh', () => {
  const gl = getProvider('gitlab');

  it('maps projects to the unified DTO', async () => {
    const fetchImpl = makeFetch([
      [
        '/projects?membership',
        {
          json: [
            {
              id: 9,
              name: 'p',
              path_with_namespace: 'g/p',
              visibility: 'private',
              default_branch: 'main',
            },
          ],
        },
      ],
    ]);
    const repos = await gl.listRepos({ token: 't', fetchImpl });
    expect(repos).toEqual([
      { id: 9, name: 'p', fullName: 'g/p', private: true, defaultBranch: 'main' },
    ]);
  });

  it('glFetch refreshes the token once on 401 and retries', async () => {
    let calls = 0;
    const fetchImpl = async (url, options) => {
      calls += 1;
      if (calls === 1) {
        return { ok: false, status: 401, json: async () => ({}), text: async () => '' };
      }
      return {
        ok: true,
        status: 200,
        json: async () => [{ name: 'main' }],
        text: async () => '',
        _auth: options.headers.Authorization,
      };
    };
    const onRefresh = vi.fn(async () => 'NEW');
    const ctx = { token: 'OLD', fetchImpl, onRefresh };
    const branches = await gl.listBranches(ctx, 'g/p');
    expect(branches).toEqual(['main']);
    expect(onRefresh).toHaveBeenCalledOnce();
    expect(ctx.token).toBe('NEW');
  });

  it('createPullRequest returns existing MR when one is already open', async () => {
    const fetchImpl = makeFetch([
      ['/repository/branches?search', { json: [] }],
      [
        '/merge_requests?source_branch',
        {
          json: [
            {
              web_url: 'https://gl/mr/3',
              iid: 3,
              source_branch: 'feat',
              target_branch: 'main',
            },
          ],
        },
      ],
    ]);
    const out = await gl.createPullRequest({ token: 't', fetchImpl }, 'g/p', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ prUrl: 'https://gl/mr/3', prNumber: 3, existing: true });
  });

  it('findPullRequest rejects rows without exact source and target identity', async () => {
    const fetchImpl = makeFetch([
      [
        '/merge_requests?source_branch=unit%2Fauth',
        {
          json: [
            { iid: 1, target_branch: 'intent' },
            { iid: 2, source_branch: 'unit/auth' },
            { iid: 3, source_branch: 'unit/auth', target_branch: 'other' },
          ],
        },
      ],
    ]);
    await expect(
      gl.findPullRequest({ token: 't', fetchImpl }, 'g/p', {
        sourceBranch: 'unit/auth',
        targetBranch: 'intent',
        state: 'opened',
      }),
    ).resolves.toBeNull();
  });

  it('supports exact lookup, draft lifecycle, reopen, status, and ancestry', async () => {
    let title = 'Draft: Auth';
    let state = 'opened';
    const fetchImpl = makeFetch([
      [
        '/merge_requests?source_branch=unit%2Fauth',
        {
          json: [
            {
              id: 70,
              iid: 7,
              source_branch: 'unit/auth',
              target_branch: 'intent',
            },
            {
              id: 80,
              iid: 8,
              source_branch: 'unit/auth',
              target_branch: 'other',
            },
          ],
        },
      ],
      [
        '/merge_requests/7',
        (_url, options) => {
          if (options.method === 'PUT') {
            const body = JSON.parse(options.body);
            if (body.title) title = body.title;
            if (body.state_event === 'reopen') state = 'opened';
          }
          return {
            json: {
              id: 70,
              iid: 7,
              web_url: 'https://gl/mr/7',
              source_branch: 'unit/auth',
              target_branch: 'intent',
              sha: 'head-7',
              diff_refs: { base_sha: 'base-7' },
              state,
              title,
              detailed_merge_status: 'mergeable',
            },
          };
        },
      ],
      [
        '/commits/head-7/refs',
        {
          json: [{ type: 'branch', name: 'intent' }],
        },
      ],
    ]);
    const found = await gl.findPullRequest({ token: 't', fetchImpl }, 'g/p', {
      sourceBranch: 'unit/auth',
      targetBranch: 'intent',
      state: 'opened',
    });
    expect(found.iid).toBe(7);
    expect(await gl.getPullRequestStatus({ token: 't', fetchImpl }, 'g/p', 7)).toMatchObject({
      state: 'open',
      draft: true,
      headSha: 'head-7',
      targetSha: 'base-7',
      mergeable: true,
    });
    expect(await gl.setPullRequestDraft({ token: 't', fetchImpl }, 'g/p', 7, false)).toMatchObject({
      state: 'open',
      draft: false,
    });
    state = 'closed';
    expect(await gl.reopenPullRequest({ token: 't', fetchImpl }, 'g/p', 7)).toMatchObject({
      state: 'open',
    });
    expect(await gl.isCommitAncestor({ token: 't', fetchImpl }, 'g/p', 'head-7', 'intent')).toBe(
      true,
    );
  });

  it('createPullRequest resolves the project default branch when baseBranch is omitted', async () => {
    const fetchImpl = makeFetch([
      ['/repository/branches?search', { json: [] }],
      ['/merge_requests?source_branch', { json: [] }],
      [
        '/merge_requests',
        (url, opts) =>
          opts.method === 'POST'
            ? { status: 201, json: { web_url: 'https://gl/mr/8', iid: 8 } }
            : { json: [] },
      ],
      ['/projects/g%2Fp', { json: { default_branch: 'develop' } }],
    ]);
    const out = await gl.createPullRequest({ token: 't', fetchImpl }, 'g/p', {
      branch: 'feat',
      baseBranch: null,
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ prUrl: 'https://gl/mr/8', prNumber: 8 });
    const postCall = fetchImpl.calls.find((c) => c.options?.method === 'POST');
    expect(JSON.parse(postCall.options.body).target_branch).toBe('develop');
  });

  it('getPullRequestState maps opened/merged/closed', async () => {
    const open = makeFetch([['/merge_requests/1', { json: { state: 'opened' } }]]);
    const merged = makeFetch([['/merge_requests/2', { json: { state: 'merged' } }]]);
    const closed = makeFetch([['/merge_requests/3', { json: { state: 'closed' } }]]);
    expect(await gl.getPullRequestState({ token: 't', fetchImpl: open }, 'g/p', 1)).toBe('open');
    expect(await gl.getPullRequestState({ token: 't', fetchImpl: merged }, 'g/p', 2)).toBe(
      'merged',
    );
    expect(await gl.getPullRequestState({ token: 't', fetchImpl: closed }, 'g/p', 3)).toBe(
      'closed',
    );
  });

  // ── 400/422 classification (2026-07 incident parity with GitHub) ──────────

  it('createPullRequest classifies a missing SOURCE branch as FAILED head_missing, never a skip', async () => {
    const fetchImpl = makeFetch([
      ['/repository/branches?search', { json: [] }],
      ['/merge_requests?source_branch', { json: [] }],
      [
        '/merge_requests',
        (url, opts) =>
          opts.method === 'POST'
            ? {
                status: 400,
                text: JSON.stringify({ message: ['Source branch "feat" does not exist'] }),
              }
            : { json: [] },
      ],
    ]);
    const out = await gl.createPullRequest({ token: 't', fetchImpl }, 'g/p', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out.failed).toBe(true);
    expect(out.reason).toBe('head_missing');
    expect(out.error).toContain('never pushed');
  });

  it('createPullRequest keeps a genuine "no commits" 400 as skipped/no_changes', async () => {
    const fetchImpl = makeFetch([
      ['/repository/branches?search', { json: [] }],
      ['/merge_requests?source_branch', { json: [] }],
      [
        '/merge_requests',
        (url, opts) =>
          opts.method === 'POST'
            ? {
                status: 400,
                text: JSON.stringify({ message: ['No commits between main and feat'] }),
              }
            : { json: [] },
      ],
    ]);
    const out = await gl.createPullRequest({ token: 't', fetchImpl }, 'g/p', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ skipped: true, reason: 'no_changes' });
  });

  // ── compareBranches — the MR fan-in pre-check ─────────────────────────────

  it('compareBranches maps commits→ahead / empty→identical and detects a missing head on 404', async () => {
    const ahead = makeFetch([['/repository/compare', { json: { commits: [{}, {}] } }]]);
    expect(
      await gl.compareBranches({ token: 't', fetchImpl: ahead }, 'g/p', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'ahead', aheadBy: 2, base: 'main' });
    const identical = makeFetch([['/repository/compare', { json: { commits: [] } }]]);
    expect(
      await gl.compareBranches({ token: 't', fetchImpl: identical }, 'g/p', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'identical', aheadBy: 0, base: 'main' });
    const headGone = makeFetch([
      ['/repository/compare', { status: 404, json: { message: '404 Not Found' } }],
      ['/repository/branches/feat', { status: 404, json: { message: '404 Branch Not Found' } }],
    ]);
    expect(
      await gl.compareBranches({ token: 't', fetchImpl: headGone }, 'g/p', {
        base: 'main',
        head: 'feat',
      }),
    ).toEqual({ status: 'missing_head', base: 'main' });
  });
});

describe('OAuth metadata', () => {
  it('exposes provider-specific secret env names and scopes', () => {
    expect(getProvider('github').oauth.secretEnvName).toBe('GITHUB_OAUTH_SECRET_NAME');
    expect(getProvider('gitlab').oauth.secretEnvName).toBe('GITLAB_OAUTH_SECRET_NAME');
    expect(getProvider('github').oauth.scopes).toBe('repo workflow read:user');
    expect(getProvider('github').oauth.requiredConnectionScopes).toEqual(['workflow']);
    expect(getProvider('gitlab').oauth.requiredConnectionScopes).toEqual(['api']);
    expect(getProvider('gitlab').oauth.refreshAccessToken).toBeTypeOf('function');
    expect(getProvider('github').oauth.refreshAccessToken).toBeUndefined();
  });

  it('gitlab refreshAccessToken sends redirect_uri (GitLab rejects refresh without it)', async () => {
    let capturedBody = null;
    const fetchImpl = async (_url, opts) => {
      capturedBody = JSON.parse(opts.body);
      return {
        json: async () => ({
          access_token: 'new-at',
          refresh_token: 'new-rt',
          token_type: 'bearer',
          expires_in: 7200,
          scope: 'api read_user',
        }),
      };
    };
    const out = await getProvider('gitlab').oauth.refreshAccessToken({
      clientId: 'cid',
      clientSecret: 'csec',
      refreshToken: 'r1',
      redirectUri: 'https://app.example.com/gitlab/callback',
      fetchImpl,
    });
    expect(capturedBody.grant_type).toBe('refresh_token');
    expect(capturedBody.redirect_uri).toBe('https://app.example.com/gitlab/callback');
    expect(out.accessToken).toBe('new-at');
  });
});
