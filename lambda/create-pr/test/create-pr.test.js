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
