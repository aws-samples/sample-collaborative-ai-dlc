import { describe, expect, it, vi } from 'vitest';

import { mergeUnmergedTaskBranches } from '../mcp-server-graph/merge-task-branches.js';

const okMerge = (status) => ({ status, text: async () => '' });

describe('mergeUnmergedTaskBranches', () => {
  it('merges each unmerged task branch into the sprint branch (201 created)', async () => {
    const requests = [];
    const fetchImpl = vi.fn(async (url, options = {}) => {
      requests.push({ url, options });
      return okMerge(201);
    });

    const result = await mergeUnmergedTaskBranches({
      owner: 'eipasteur',
      repo: 'retail-store-ui',
      sprintBranch: 'ai-dlc/e2e-123',
      unmergedBranches: ['ai-dlc/e2e-123--task-ui', 'ai-dlc/e2e-123--task-infra'],
      gitToken: 'token',
      fetchImpl,
    });

    expect(result).toEqual({
      merged: ['ai-dlc/e2e-123--task-ui', 'ai-dlc/e2e-123--task-infra'],
      conflicts: [],
      errors: [],
    });
    expect(requests).toHaveLength(2);
    expect(requests[0].url).toBe('https://api.github.com/repos/eipasteur/retail-store-ui/merges');
    expect(requests[0].options.method).toBe('POST');
    const body = JSON.parse(requests[0].options.body);
    expect(body).toMatchObject({ base: 'ai-dlc/e2e-123', head: 'ai-dlc/e2e-123--task-ui' });
  });

  it('treats 204 (already merged / nothing to merge) as success for idempotent re-runs', async () => {
    const fetchImpl = vi.fn(async () => okMerge(204));

    const result = await mergeUnmergedTaskBranches({
      owner: 'o',
      repo: 'r',
      sprintBranch: 'sprint',
      unmergedBranches: ['sprint--task-a'],
      gitToken: 'token',
      fetchImpl,
    });

    expect(result.merged).toEqual(['sprint--task-a']);
    expect(result.conflicts).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  it('surfaces a 409 merge conflict without force-resolving it', async () => {
    const fetchImpl = vi.fn(async () => okMerge(409));

    const result = await mergeUnmergedTaskBranches({
      owner: 'o',
      repo: 'r',
      sprintBranch: 'sprint',
      unmergedBranches: ['sprint--task-conflict'],
      gitToken: 'token',
      fetchImpl,
    });

    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual(['sprint--task-conflict']);
    expect(result.errors).toEqual([]);
  });

  it('records non-2xx/409 responses as errors', async () => {
    const fetchImpl = vi.fn(async () => ({ status: 422, text: async () => 'ref not found' }));

    const result = await mergeUnmergedTaskBranches({
      owner: 'o',
      repo: 'r',
      sprintBranch: 'sprint',
      unmergedBranches: ['sprint--task-missing'],
      gitToken: 'token',
      fetchImpl,
    });

    expect(result.merged).toEqual([]);
    expect(result.conflicts).toEqual([]);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].branch).toBe('sprint--task-missing');
    expect(result.errors[0].message).toContain('422');
  });

  it('records a thrown fetch (network) error per branch and continues', async () => {
    const fetchImpl = vi.fn(async (url, options) => {
      const { head } = JSON.parse(options.body);
      if (head === 'sprint--task-a') throw new Error('network down');
      return okMerge(201);
    });

    const result = await mergeUnmergedTaskBranches({
      owner: 'o',
      repo: 'r',
      sprintBranch: 'sprint',
      unmergedBranches: ['sprint--task-a', 'sprint--task-b'],
      gitToken: 'token',
      fetchImpl,
    });

    expect(result.merged).toEqual(['sprint--task-b']);
    expect(result.errors).toEqual([{ branch: 'sprint--task-a', message: 'network down' }]);
  });

  it('is a no-op for an empty or missing branch list', async () => {
    const fetchImpl = vi.fn();

    const empty = await mergeUnmergedTaskBranches({
      owner: 'o',
      repo: 'r',
      sprintBranch: 'sprint',
      unmergedBranches: [],
      gitToken: 'token',
      fetchImpl,
    });
    const missing = await mergeUnmergedTaskBranches({
      owner: 'o',
      repo: 'r',
      sprintBranch: 'sprint',
      gitToken: 'token',
      fetchImpl,
    });

    expect(empty).toEqual({ merged: [], conflicts: [], errors: [] });
    expect(missing).toEqual({ merged: [], conflicts: [], errors: [] });
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
