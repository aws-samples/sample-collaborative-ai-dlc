import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
const put = vi.fn();
const get = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
}));

import { projectsService } from './projects';

describe('projectsService v2 create/update payloads', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({});
    put.mockReset().mockResolvedValue({});
    get.mockReset();
  });

  it('create forwards the v2 kind + workflow/scope/park fields verbatim', async () => {
    const input = {
      name: 'V2',
      gitProvider: 'github' as const,
      gitRepo: 'owner/repo',
      kind: 'v2' as const,
      workflowId: 'aidlc-v2',
      scope: 'feature',
      parkReleaseSeconds: 120,
    };
    await projectsService.create(input);
    expect(post).toHaveBeenCalledWith('/projects', input);
  });

  it('update can set parkReleaseSeconds', async () => {
    await projectsService.update('p1', { parkReleaseSeconds: 300 });
    expect(put).toHaveBeenCalledWith('/projects/p1', { parkReleaseSeconds: 300 });
  });

  it('update can set maxParallelUnits + prStrategy (WP5/WP6 settings)', async () => {
    await projectsService.update('p1', { maxParallelUnits: 3, prStrategy: 'intent-pr' });
    expect(put).toHaveBeenCalledWith('/projects/p1', {
      maxParallelUnits: 3,
      prStrategy: 'intent-pr',
    });
  });

  it('loads every member page and normalizes legacy admin to owner', async () => {
    get
      .mockResolvedValueOnce({
        members: [{ userId: 'u1', role: 'admin' }],
        nextToken: 'next page',
      })
      .mockResolvedValueOnce({
        members: [{ userId: 'u2', role: 'member' }],
      });

    await expect(projectsService.listMembers('p1')).resolves.toEqual([
      { userId: 'u1', role: 'owner' },
      { userId: 'u2', role: 'member' },
    ]);
    expect(get).toHaveBeenNthCalledWith(1, '/projects/p1/members?limit=50');
    expect(get).toHaveBeenNthCalledWith(2, '/projects/p1/members?limit=50&nextToken=next%20page');
  });
});
