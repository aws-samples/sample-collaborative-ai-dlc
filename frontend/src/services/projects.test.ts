import { describe, it, expect, vi, beforeEach } from 'vitest';

const post = vi.fn();
const put = vi.fn();
vi.mock('./api', () => ({
  api: { post: (...a: unknown[]) => post(...a), put: (...a: unknown[]) => put(...a) },
}));

import { projectsService } from './projects';

describe('projectsService v2 create/update payloads', () => {
  beforeEach(() => {
    post.mockReset().mockResolvedValue({});
    put.mockReset().mockResolvedValue({});
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
});
