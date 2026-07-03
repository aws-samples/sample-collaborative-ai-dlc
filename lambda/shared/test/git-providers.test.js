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
      ['/merge_requests?source_branch', { json: [{ web_url: 'https://gl/mr/3', iid: 3 }] }],
    ]);
    const out = await gl.createPullRequest({ token: 't', fetchImpl }, 'g/p', {
      branch: 'feat',
      baseBranch: 'main',
      title: 'T',
      body: 'B',
    });
    expect(out).toEqual({ prUrl: 'https://gl/mr/3', prNumber: 3, existing: true });
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
});

describe('OAuth metadata', () => {
  it('exposes provider-specific secret env names and scopes', () => {
    expect(getProvider('github').oauth.secretEnvName).toBe('GITHUB_OAUTH_SECRET_NAME');
    expect(getProvider('gitlab').oauth.secretEnvName).toBe('GITLAB_OAUTH_SECRET_NAME');
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
