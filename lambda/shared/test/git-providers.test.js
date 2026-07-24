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
    expect(isKnownProvider('bitbucket')).toBe(true);
    expect(isKnownProvider('nope')).toBe(false);
  });

  it('throws ProviderError for an unknown provider', () => {
    expect(() => getProvider('nope')).toThrow(ProviderError);
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
              id: 9009,
              node_id: 'PR_existing',
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
              id: 7007,
              node_id: 'PR_7',
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
              id: 7007,
              node_id: 'PR_7',
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
          const { query, variables } = JSON.parse(options.body);
          expect(variables.id).toBe('PR_7');
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
      providerId: 'PR_7',
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

describe('bitbucket provider — workspace listing + tree + ancestor + validation', () => {
  const bb = getProvider('bitbucket');

  it('splitWorkspaceRepo rejects injection and malformed refs', () => {
    expect(() => bb.splitWorkspaceRepo('ws/repo/extra')).toThrow(ProviderError);
    expect(() => bb.splitWorkspaceRepo('ws')).toThrow(ProviderError);
    expect(() => bb.splitWorkspaceRepo('ws/repo?x=1')).toThrow(ProviderError);
    expect(() => bb.splitWorkspaceRepo('../repo')).toThrow(ProviderError);
    expect(() => bb.splitWorkspaceRepo('ws/..')).toThrow(ProviderError);
    expect(() => bb.splitWorkspaceRepo('ws/re po')).toThrow(ProviderError);
    expect(() => bb.splitWorkspaceRepo('../etc/passwd')).toThrow(ProviderError);
    expect(bb.splitWorkspaceRepo('my-ws/my.repo_1')).toEqual({
      workspace: 'my-ws',
      repoSlug: 'my.repo_1',
    });
  });

  it('buildCloneUrl uses the x-token-auth scheme', () => {
    expect(bb.buildCloneUrl('ws/repo', 'tok')).toBe(
      'https://x-token-auth:tok@bitbucket.org/ws/repo.git',
    );
    expect(bb.buildCloneUrl('ws/repo')).toBe('https://bitbucket.org/ws/repo.git');
  });

  it('listRepos enumerates via /user/workspaces then aggregates per-workspace repos', async () => {
    const fetchImpl = makeFetch([
      // /user/workspaces returns MEMBERSHIP objects nesting the workspace under
      // `.workspace` (slug at item.workspace.slug). Include one nested and one
      // top-level shape so the resolver must handle both.
      [
        '/user/workspaces',
        { json: { values: [{ workspace: { slug: 'acme' } }, { slug: 'beta' }] } },
      ],
      [
        '/repositories/acme?role=member',
        {
          json: {
            values: [
              {
                uuid: '{1}',
                name: 'app',
                full_name: 'acme/app',
                is_private: true,
                mainbranch: { name: 'main' },
              },
            ],
          },
        },
      ],
      [
        '/repositories/beta?role=member',
        {
          json: {
            values: [
              {
                uuid: '{2}',
                name: 'lib',
                full_name: 'beta/lib',
                is_private: false,
                mainbranch: { name: 'develop' },
              },
            ],
          },
        },
      ],
    ]);
    const repos = await bb.listRepos({ token: 't', fetchImpl });
    expect(repos).toEqual([
      { id: '{1}', name: 'app', fullName: 'acme/app', private: true, defaultBranch: 'main' },
      { id: '{2}', name: 'lib', fullName: 'beta/lib', private: false, defaultBranch: 'develop' },
    ]);
    // Must hit the CHANGE-2770-safe workspace endpoint, never the removed
    // cross-workspace ?role=member listing.
    expect(fetchImpl.calls.some((c) => c.url.includes('/user/workspaces'))).toBe(true);
    expect(fetchImpl.calls.some((c) => /\/repositories\?role=member/.test(c.url))).toBe(false);
  });

  it('listRepos surfaces a clear error when the token cannot enumerate workspaces (410)', async () => {
    const fetchImpl = makeFetch([['/user/workspaces', { status: 410, json: {} }]]);
    await expect(bb.listRepos({ token: 't', fetchImpl })).rejects.toThrow(ProviderError);
  });

  it('getTree walks subdirectories (max_depth) and paginates', async () => {
    let page = 0;
    const fetchImpl = makeFetch([
      [
        '/src/main/',
        () => {
          page += 1;
          return page === 1
            ? {
                json: {
                  values: [
                    { type: 'commit_directory', path: 'src' },
                    { type: 'commit_file', path: 'README.md', size: 10, commit: { hash: 'a1' } },
                  ],
                  next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/src/main/?page=2',
                },
              }
            : {
                json: {
                  values: [
                    {
                      type: 'commit_file',
                      path: 'src/App.java',
                      size: 20,
                      commit: { hash: 'b2' },
                    },
                  ],
                },
              };
        },
      ],
    ]);
    const tree = await bb.getTree({ token: 't', fetchImpl }, 'ws/repo', 'main');
    expect(tree).toEqual([
      { path: 'README.md', sha: 'a1', size: 10 },
      { path: 'src/App.java', sha: 'b2', size: 20 },
    ]);
    expect(fetchImpl.calls[0].url).toContain('max_depth=100');
  });

  it('isCommitAncestor uses the merge-base endpoint (single call) and matches on hash', async () => {
    const fetchImpl = makeFetch([['/merge-base/', { json: { hash: 'target-sha' } }]]);
    expect(
      await bb.isCommitAncestor({ token: 't', fetchImpl }, 'ws/repo', 'target-sha', 'intent'),
    ).toBe(true);
    // Exactly one API call — no O(history) commit-log walk.
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).toContain('/merge-base/target-sha..intent');
  });

  it('isCommitAncestor matches when merge-base returns the full hash for a short ancestor', async () => {
    const fetchImpl = makeFetch([['/merge-base/', { json: { hash: 'abcdef1234567890' } }]]);
    expect(
      await bb.isCommitAncestor({ token: 't', fetchImpl }, 'ws/repo', 'abcdef1', 'intent'),
    ).toBe(true);
  });

  it('isCommitAncestor returns false when the merge-base is a different commit', async () => {
    const fetchImpl = makeFetch([['/merge-base/', { json: { hash: 'other-sha' } }]]);
    expect(
      await bb.isCommitAncestor({ token: 't', fetchImpl }, 'ws/repo', 'missing-sha', 'intent'),
    ).toBe(false);
  });

  it('reopenPullRequest throws (Bitbucket cannot reopen declined PRs via API)', async () => {
    await expect(
      bb.reopenPullRequest({ token: 't', fetchImpl: makeFetch([]) }, 'ws/repo', 1),
    ).rejects.toThrow(ProviderError);
  });

  it('setPullRequestDraft short-circuits when the native draft flag already matches', async () => {
    // Bitbucket Cloud exposes a native `draft` boolean; when the PR is already
    // in the requested draft state the call short-circuits after the status
    // read (no PUT).
    const fetchImpl = makeFetch([
      ['/pullrequests/1', { json: { id: 1, state: 'OPEN', title: 'feat', draft: true } }],
    ]);
    const out = await bb.setPullRequestDraft({ token: 't', fetchImpl }, 'ws/repo', 1, true);
    expect(out).toMatchObject({ state: 'open', draft: true });
    // No PUT issued because the desired state already matched.
    expect(fetchImpl.calls.every((c) => (c.options.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('setPullRequestDraft sets the native draft boolean via PUT (no title mangling)', async () => {
    let draft = false;
    const fetchImpl = makeFetch([
      [
        '/pullrequests/1',
        (url, options) => {
          if ((options?.method ?? 'GET') === 'PUT') {
            const body = JSON.parse(options.body);
            draft = body.draft;
            // The title must NOT be touched by a draft transition.
            expect(body.title).toBeUndefined();
            return { json: { id: 1, state: 'OPEN', title: 'feat', draft } };
          }
          return { json: { id: 1, state: 'OPEN', title: 'feat', draft } };
        },
      ],
    ]);
    const out = await bb.setPullRequestDraft({ token: 't', fetchImpl }, 'ws/repo', 1, true);
    expect(out).toMatchObject({ state: 'open', draft: true });
    expect(fetchImpl.calls.some((c) => (c.options.method ?? 'GET') === 'PUT')).toBe(true);
  });

  it('findPullRequest names the draft field so draft PRs are not hidden (BCLOUD-23659)', async () => {
    const fetchImpl = makeFetch([['/pullrequests', { json: { values: [{ id: 9 }] } }]]);
    await bb.findPullRequest({ token: 't', fetchImpl }, 'ws/repo', {
      sourceBranch: 'feat',
      targetBranch: 'main',
    });
    const url = decodeURIComponent(fetchImpl.calls[0].url);
    expect(url).toContain('draft=true OR draft=false');
  });

  it('getFileContents encodes each path segment but preserves the slashes', async () => {
    const fetchImpl = makeFetch([['/src/', { text: 'file body', json: {} }]]);
    await bb.getFileContents({ token: 't', fetchImpl }, 'ws/repo', 'src/main/App.java', 'main');
    const url = fetchImpl.calls[0].url;
    // Slashes between segments stay literal; only segment contents are encoded.
    expect(url).toContain('/src/main/src/main/App.java');
    expect(url).not.toContain('src%2Fmain%2FApp.java');
  });

  it('getFileContents percent-encodes reserved chars WITHIN a segment', async () => {
    const fetchImpl = makeFetch([['/src/', { text: 'x', json: {} }]]);
    await bb.getFileContents({ token: 't', fetchImpl }, 'ws/repo', 'dir/a b.txt', 'main');
    const url = fetchImpl.calls[0].url;
    expect(url).toContain('/dir/a%20b.txt');
  });

  it('listBranches follows pagination (data.next) across pages', async () => {
    const fetchImpl = makeFetch([
      [
        '/refs/branches',
        (url) =>
          url.includes('page=2')
            ? { json: { values: [{ name: 'feature/b' }] } }
            : {
                json: {
                  values: [{ name: 'main' }],
                  next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/refs/branches?page=2',
                },
              },
      ],
    ]);
    const names = await bb.listBranches({ token: 't', fetchImpl }, 'ws/repo');
    expect(names).toEqual(['main', 'feature/b']);
    expect(fetchImpl.calls.some((c) => c.url.includes('page=2'))).toBe(true);
  });

  it('getUnmergedConstructionTaskBranches sees task branches beyond page 1', async () => {
    const branchPage = (url) =>
      url.includes('page=2')
        ? { json: { values: [{ name: 'intent--task-late' }] } }
        : {
            json: {
              values: [{ name: 'main' }],
              next: 'https://api.bitbucket.org/2.0/repositories/ws/repo/refs/branches?page=2',
            },
          };
    const fetchImpl = makeFetch([
      ['/refs/branches', branchPage],
      // task branch is NOT merged: exclude returns a commit
      ['/commits/intent--task-late', { json: { values: [{ hash: 'c1' }] } }],
    ]);
    const unmerged = await bb.getUnmergedConstructionTaskBranches(
      { token: 't', fetchImpl },
      'ws/repo',
      'intent',
    );
    expect(unmerged).toContain('intent--task-late');
  });

  it('listPRComments fetches the comment list once and partitions by inline', async () => {
    const fetchImpl = makeFetch([
      [
        '/pullrequests/7/comments',
        {
          json: {
            values: [
              {
                id: 1,
                content: { raw: 'general' },
                user: { nickname: 'jane' },
                created_on: '2026-01-01',
              },
              {
                id: 2,
                content: { raw: 'inline' },
                inline: { path: 'a.js', to: 3 },
                user: { nickname: 'bob' },
                created_on: '2026-01-02',
              },
            ],
          },
        },
      ],
    ]);
    const comments = await bb.listPRComments({ token: 't', fetchImpl }, 'ws/repo', 7);
    // Exactly one network call (no second q=inline!=null request).
    expect(fetchImpl.calls).toHaveLength(1);
    expect(fetchImpl.calls[0].url).not.toContain('inline!=null');
    expect(comments.map((c) => c.type)).toEqual(['issue', 'review']);
    expect(comments[1]).toMatchObject({ path: 'a.js', line: 3 });
  });

  it('maps comment authors via nickname and never mislabels teams as bots', async () => {
    const fetchImpl = makeFetch([
      [
        '/pullrequests/7/comments',
        {
          json: {
            values: [
              {
                id: 1,
                content: { raw: 'x' },
                user: { nickname: 'acme-team', type: 'team' },
                created_on: '2026-01-01',
              },
            ],
          },
        },
      ],
    ]);
    const [c] = await bb.listPRComments({ token: 't', fetchImpl }, 'ws/repo', 7);
    expect(c.user.login).toBe('acme-team');
    expect(c.bot).toBe(false);
  });

  it('mergeBranch declines the temporary PR when the merge conflicts', async () => {
    const fetchImpl = makeFetch([
      ['/pullrequests/1/merge', { status: 409, json: { error: { message: 'conflict' } } }],
      ['/pullrequests/1/decline', { json: { id: 1, state: 'DECLINED' } }],
      // create-PR (generic pullrequests POST) returns the temp PR id
      ['/pullrequests', { json: { id: 1 } }],
    ]);
    const out = await bb.mergeBranch({ token: 't', fetchImpl }, 'ws/repo', {
      base: 'main',
      head: 'feat',
    });
    expect(out).toBe('conflict');
    expect(fetchImpl.calls.some((c) => c.url.includes('/pullrequests/1/decline'))).toBe(true);
  });

  it('getAuthenticatedUser resolves login from nickname and email from /user/emails', async () => {
    const fetchImpl = makeFetch([
      [
        '/user/emails',
        {
          json: {
            values: [
              { email: 'alt@example.com', is_primary: false, is_confirmed: true },
              { email: 'jane@example.com', is_primary: true, is_confirmed: true },
            ],
          },
        },
      ],
      ['/user', { json: { account_id: 'acc-1', nickname: 'jane', display_name: 'Jane Dev' } }],
    ]);
    const user = await bb.getAuthenticatedUser({ token: 't', fetchImpl });
    expect(user).toEqual({
      login: 'jane',
      authorName: 'Jane Dev',
      authorEmail: 'jane@example.com',
    });
  });

  it('getAuthenticatedUser falls back to a noreply email when /user/emails is unavailable', async () => {
    const fetchImpl = makeFetch([
      ['/user/emails', { status: 403, json: {} }],
      ['/user', { json: { account_id: 'acc-9', nickname: 'bob', display_name: 'Bob' } }],
    ]);
    const user = await bb.getAuthenticatedUser({ token: 't', fetchImpl });
    expect(user.login).toBe('bob');
    expect(user.authorEmail).toBe('acc-9@users.noreply.bitbucket.org');
  });

  it('getRepositoryAccess reports write access from the permissions probe', async () => {
    const fetchImpl = makeFetch([
      ['/user/permissions/repositories', { json: { values: [{ permission: 'write' }] } }],
      [
        '/repositories/ws/repo',
        { json: { uuid: '{u}', is_private: true, mainbranch: { name: 'main' } } },
      ],
    ]);
    const access = await bb.getRepositoryAccess({ token: 't', fetchImpl }, 'ws/repo');
    expect(access).toMatchObject({
      defaultBranch: 'main',
      private: true,
      permission: 'write',
      canRead: true,
      canWrite: true,
    });
  });

  it('getRepositoryAccess degrades to read-only when the permissions probe fails', async () => {
    const fetchImpl = makeFetch([
      ['/user/permissions/repositories', { status: 500, json: {} }],
      [
        '/repositories/ws/repo',
        { json: { uuid: '{u}', is_private: false, mainbranch: { name: 'dev' } } },
      ],
    ]);
    const access = await bb.getRepositoryAccess({ token: 't', fetchImpl }, 'ws/repo');
    expect(access).toMatchObject({ defaultBranch: 'dev', canRead: true, canWrite: false });
  });
});

describe('OAuth metadata', () => {
  it('exposes provider-specific secret env names and scopes', () => {
    expect(getProvider('github').oauth.secretEnvName).toBe('GITHUB_OAUTH_SECRET_NAME');
    expect(getProvider('gitlab').oauth.secretEnvName).toBe('GITLAB_OAUTH_SECRET_NAME');
    expect(getProvider('github').oauth.scopes).toBe('repo workflow read:user');
    expect(getProvider('github').oauth.requiredConnectionScopes).toEqual([
      'repo',
      'workflow',
      'read:user',
    ]);
    expect(getProvider('gitlab').oauth.requiredConnectionScopes).toEqual(['api', 'read_user']);
    expect(getProvider('gitlab').oauth.refreshAccessToken).toBeTypeOf('function');
    expect(getProvider('github').oauth.refreshAccessToken).toBeUndefined();
    // Bitbucket OAuth scopes MUST be singular scope names (not the plural REST
    // path names) or the authorize call fails with "Unknown scope".
    expect(getProvider('bitbucket').oauth.secretEnvName).toBe('BITBUCKET_OAUTH_SECRET_NAME');
    expect(getProvider('bitbucket').oauth.scopes).toBe(
      'account email repository repository:write pullrequest pullrequest:write',
    );
    expect(getProvider('bitbucket').oauth.refreshAccessToken).toBeTypeOf('function');
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
