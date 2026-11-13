import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
const put = vi.fn();
const get = vi.fn();
vi.mock('./api', () => ({
  api: {
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
    get: (...a: unknown[]) => get(...a),
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

  it('follows a user-space continuation token even when the first page is empty', async () => {
    get
      .mockResolvedValueOnce({ items: [], nextToken: 'next/page' })
      .mockResolvedValueOnce({ items: [{ id: 'p1', userRole: 'member' }], nextToken: null });
    expect(await projectsService.list()).toEqual([{ id: 'p1', userRole: 'member' }]);
    expect(get.mock.calls).toEqual([
      ['/projects?paged=1'],
      ['/projects?paged=1&nextToken=next%2Fpage'],
    ]);
  });

  it('loads all member pages and propagates a failed continuation request', async () => {
    get
      .mockResolvedValueOnce({ items: [{ userId: 'u1', role: 'owner' }], nextToken: 'next' })
      .mockResolvedValueOnce({ items: [{ userId: 'u2', role: 'member' }], nextToken: null });
    expect(await projectsService.listMembers('p1')).toEqual([
      { userId: 'u1', role: 'owner' },
      { userId: 'u2', role: 'member' },
    ]);
    expect(get.mock.calls.slice(0, 2)).toEqual([
      ['/projects/p1/members?paged=1'],
      ['/projects/p1/members?paged=1&nextToken=next'],
    ]);
    get
      .mockResolvedValueOnce({ items: [], nextToken: 'next' })
      .mockRejectedValueOnce(new Error('Unavailable'));
    await expect(projectsService.listMembers('p1')).rejects.toThrow('Unavailable');
  });

  it('accepts legacy arrays while an older backend is running after rollback', async () => {
    get.mockResolvedValueOnce([{ id: 'legacy-space' }]);
    expect(await projectsService.list()).toEqual([{ id: 'legacy-space' }]);
    get.mockResolvedValueOnce([{ userId: 'owner', role: 'owner' }]);
    expect(await projectsService.listMembers('legacy-space')).toEqual([
      { userId: 'owner', role: 'owner' },
    ]);
    expect(get).toHaveBeenCalledTimes(2);
  });
});
