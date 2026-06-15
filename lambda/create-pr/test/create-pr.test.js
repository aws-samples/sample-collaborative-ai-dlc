import { describe, expect, it, vi } from 'vitest';

const loadCreatePr = async () => await import('../create-pr.js');

describe('create-pr construction branch cleanup', () => {
  it('deletes only task branches for the branch used to create the PR', async () => {
    const { cleanupConstructionTaskBranches } = await loadCreatePr();
    const requests = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/git/matching-refs/')) {
        return {
          ok: true,
          json: async () => [
            { ref: 'refs/heads/ai-dlc/feature/dashboard-improvement-1780474313832' },
            {
              ref: 'refs/heads/ai-dlc/feature/dashboard-improvement-1780474313832--task-sse-backend',
            },
            {
              ref: 'refs/heads/ai-dlc/feature/dashboard-improvement-1780474313832--task-sse-frontend',
            },
            { ref: 'refs/heads/ai-dlc/feature/other--task-unrelated' },
          ],
        };
      }
      if (url.includes('/compare/')) return { ok: true, json: async () => ({ status: 'ahead' }) };
      return { ok: true, text: async () => '' };
    });

    const result = await cleanupConstructionTaskBranches({
      owner: 'owner',
      repo: 'repo',
      branch: 'ai-dlc/feature/dashboard-improvement-1780474313832',
      ghHeaders: { Authorization: 'token token' },
      fetchImpl,
    });

    expect(result).toEqual({ deleted: 2, failed: 0, skipped: 0 });
    expect(requests.map((request) => request.url)).toEqual([
      'https://api.github.com/repos/owner/repo/git/matching-refs/heads/ai-dlc/feature/dashboard-improvement-1780474313832--task-',
      'https://api.github.com/repos/owner/repo/compare/ai-dlc%2Ffeature%2Fdashboard-improvement-1780474313832--task-sse-backend...ai-dlc%2Ffeature%2Fdashboard-improvement-1780474313832',
      'https://api.github.com/repos/owner/repo/git/refs/heads/ai-dlc/feature/dashboard-improvement-1780474313832--task-sse-backend',
      'https://api.github.com/repos/owner/repo/compare/ai-dlc%2Ffeature%2Fdashboard-improvement-1780474313832--task-sse-frontend...ai-dlc%2Ffeature%2Fdashboard-improvement-1780474313832',
      'https://api.github.com/repos/owner/repo/git/refs/heads/ai-dlc/feature/dashboard-improvement-1780474313832--task-sse-frontend',
    ]);
    expect(requests.filter((request) => request.options.method === 'DELETE')).toHaveLength(2);
  });

  it('does not delete task branches that are not merged into the PR branch', async () => {
    const { cleanupConstructionTaskBranches } = await loadCreatePr();
    const requests = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/git/matching-refs/')) {
        return {
          ok: true,
          json: async () => [{ ref: 'refs/heads/ai-dlc/sprint-1--task-api' }],
        };
      }
      if (url.includes('/compare/'))
        return { ok: true, json: async () => ({ status: 'diverged' }) };
      return { ok: true, text: async () => '' };
    });

    const result = await cleanupConstructionTaskBranches({
      owner: 'owner',
      repo: 'repo',
      branch: 'ai-dlc/sprint-1',
      ghHeaders: { Authorization: 'token token' },
      fetchImpl,
    });

    expect(result).toEqual({ deleted: 0, failed: 0, skipped: 1 });
    expect(requests.some((request) => request.options.method === 'DELETE')).toBe(false);
  });

  it('runs cleanup after a PR is created', async () => {
    const { handler } = await loadCreatePr();
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      requests.push({ url, options });
      if (url.endsWith('/pulls')) {
        return {
          ok: true,
          json: async () => ({ html_url: 'https://github.com/owner/repo/pull/7', number: 7 }),
        };
      }
      if (url.includes('/git/matching-refs/')) {
        return {
          ok: true,
          json: async () => [{ ref: 'refs/heads/ai-dlc/sprint-1--task-auth' }],
        };
      }
      if (url.includes('/compare/')) return { ok: true, json: async () => ({ status: 'ahead' }) };
      return { ok: true, text: async () => '' };
    });

    try {
      const result = await handler({
        projectId: 'project-1',
        branch: 'ai-dlc/sprint-1',
        baseBranch: 'main',
        gitRepo: 'owner/repo',
        gitToken: 'token',
        executionId: 'exec-1',
      });

      expect(result).toMatchObject({
        statusCode: 200,
        prUrl: 'https://github.com/owner/repo/pull/7',
        prNumber: 7,
      });
      expect(requests.map((request) => request.url)).toContain(
        'https://api.github.com/repos/owner/repo/git/refs/heads/ai-dlc/sprint-1--task-auth',
      );
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('refuses to create a PR when completed task branches are not merged', async () => {
    const { handler } = await loadCreatePr();
    const requests = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (url, options = {}) => {
      requests.push({ url, options });
      if (url.includes('/git/matching-refs/')) {
        return {
          ok: true,
          json: async () => [{ ref: 'refs/heads/ai-dlc/sprint-1--task-auth' }],
        };
      }
      if (url.includes('/compare/')) return { ok: true, json: async () => ({ status: 'behind' }) };
      return { ok: true, json: async () => ({}) };
    });

    try {
      const result = await handler({
        projectId: 'project-1',
        branch: 'ai-dlc/sprint-1',
        baseBranch: 'main',
        gitRepo: 'owner/repo',
        gitToken: 'token',
        executionId: 'exec-1',
      });

      expect(result).toMatchObject({
        statusCode: 409,
        unmergedBranches: ['ai-dlc/sprint-1--task-auth'],
      });
      expect(requests.some((request) => request.url.endsWith('/pulls'))).toBe(false);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('create-pr handler — gitRepo validation', () => {
  it('returns 400 when gitRepo is missing a slash', async () => {
    const { handler } = await loadCreatePr();
    const result = await handler({
      projectId: 'p1',
      branch: 'ai-dlc/sprint-1',
      baseBranch: 'main',
      gitRepo: 'no-slash-here',
      gitToken: 'token',
      executionId: 'e1',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatch(/expected "owner\/repo"/);
  });

  it('returns 400 when gitRepo has too many segments', async () => {
    const { handler } = await loadCreatePr();
    const result = await handler({
      projectId: 'p1',
      branch: 'ai-dlc/sprint-1',
      baseBranch: 'main',
      gitRepo: 'owner/repo/extra',
      gitToken: 'token',
      executionId: 'e1',
    });
    expect(result.statusCode).toBe(400);
    expect(result.body).toMatch(/expected "owner\/repo"/);
  });

  it('returns 400 when gitRepo is empty', async () => {
    const { handler } = await loadCreatePr();
    const result = await handler({
      projectId: 'p1',
      branch: 'ai-dlc/sprint-1',
      baseBranch: 'main',
      gitRepo: '',
      gitToken: 'token',
      executionId: 'e1',
    });
    expect(result.statusCode).toBe(400);
  });
});

describe('create-pr handler — findByBranch fallback (PR already exists)', () => {
  const makeExistingPrFetch = ({ preciseFinds = true, matchingPr = null } = {}) =>
    vi.fn(async (url) => {
      if (url.includes('/git/matching-refs/')) return { ok: true, json: async () => [] }; // no task branches
      // First PR creation attempt — 422 (already exists)
      if (url.endsWith('/pulls') && !url.includes('?'))
        return { ok: false, status: 422, text: async () => 'Unprocessable' };
      // Precise head-qualified lookup
      if (url.includes('?head=') && url.includes(':')) {
        const prs = preciseFinds
          ? [
              {
                html_url: 'https://github.com/owner/repo/pull/3',
                number: 3,
                head: { ref: 'feat/x' },
              },
            ]
          : [];
        return { ok: true, json: async () => prs };
      }
      // Fallback list lookup
      const prs = matchingPr ? [matchingPr] : [];
      return { ok: true, json: async () => prs };
    });

  it('returns the existing open PR when the precise head-qualified lookup finds it', async () => {
    const { handler } = await loadCreatePr();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeExistingPrFetch({ preciseFinds: true });
    try {
      const result = await handler({
        projectId: 'p1',
        branch: 'feat/x',
        baseBranch: 'main',
        gitRepo: 'owner/repo',
        gitToken: 'token',
        executionId: 'e1',
      });
      expect(result).toMatchObject({ statusCode: 200, prNumber: 3, existing: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('falls back to listing PRs when head-qualified lookup returns empty (fork/org mismatch)', async () => {
    // Simulates a fork where the PR head is forkOwner:feat/x — the precise
    // owner:branch filter returns nothing, so we fall through to the full list.
    const { handler } = await loadCreatePr();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeExistingPrFetch({
      preciseFinds: false,
      matchingPr: {
        html_url: 'https://github.com/owner/repo/pull/9',
        number: 9,
        head: { ref: 'feat/x' },
      },
    });
    try {
      const result = await handler({
        projectId: 'p1',
        branch: 'feat/x',
        baseBranch: 'main',
        gitRepo: 'owner/repo',
        gitToken: 'token',
        executionId: 'e1',
      });
      expect(result).toMatchObject({ statusCode: 200, prNumber: 9, existing: true });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('returns 500 when neither lookup finds the PR', async () => {
    const { handler } = await loadCreatePr();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeExistingPrFetch({ preciseFinds: false, matchingPr: null });
    try {
      const result = await handler({
        projectId: 'p1',
        branch: 'feat/x',
        baseBranch: 'main',
        gitRepo: 'owner/repo',
        gitToken: 'token',
        executionId: 'e1',
      });
      // Neither open nor any state found — falls through to the throw at line 253
      expect(result.statusCode).toBe(500);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('create-pr handler — benign 422 (repo has no changes this sprint)', () => {
  const makeNoPrFetch = (errorBody) =>
    vi.fn(async (url) => {
      if (url.includes('/git/matching-refs/')) return { ok: true, json: async () => [] };
      if (url.endsWith('/pulls') && !url.includes('?'))
        return { ok: false, status: 422, text: async () => errorBody };
      // Both the head-qualified and the list lookups find nothing.
      return { ok: true, json: async () => [] };
    });

  const invoke = async (errorBody) => {
    const { handler } = await loadCreatePr();
    const originalFetch = globalThis.fetch;
    globalThis.fetch = makeNoPrFetch(errorBody);
    try {
      return await handler({
        projectId: 'p1',
        branch: 'feat/x',
        baseBranch: 'main',
        gitRepo: 'owner/repo',
        gitToken: 'token',
        executionId: 'e1',
      });
    } finally {
      globalThis.fetch = originalFetch;
    }
  };

  it('returns skipped/no_changes when GitHub reports no commits between base and head', async () => {
    const result = await invoke(
      JSON.stringify({
        message: 'Validation Failed',
        errors: [
          {
            resource: 'PullRequest',
            code: 'custom',
            message: 'No commits between main and feat/x',
          },
        ],
      }),
    );
    expect(result).toEqual({ statusCode: 200, skipped: true, reason: 'no_changes' });
  });

  it('returns skipped/no_changes when the head branch was never pushed (field head invalid)', async () => {
    const result = await invoke(
      JSON.stringify({
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }],
      }),
    );
    expect(result).toEqual({ statusCode: 200, skipped: true, reason: 'no_changes' });
  });

  it('returns skipped/no_changes on the legacy "head sha can\'t be blank" message', async () => {
    const result = await invoke(
      JSON.stringify({
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', code: 'custom', message: "head sha can't be blank" }],
      }),
    );
    expect(result).toEqual({ statusCode: 200, skipped: true, reason: 'no_changes' });
  });

  it('still returns 500 for a real 422 with a different message', async () => {
    const result = await invoke(
      JSON.stringify({
        message: 'Validation Failed',
        errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }],
      }),
    );
    expect(result.statusCode).toBe(500);
    expect(result.skipped).toBeUndefined();
    expect(result.error).toMatch(/Failed to create PR: 422/);
  });
});
