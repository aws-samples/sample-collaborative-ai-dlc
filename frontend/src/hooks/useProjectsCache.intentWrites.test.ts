import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('@/services/api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));
vi.mock('@/services/projects', () => ({
  projectsService: { list: async () => [{ id: 'p1', name: 'Space', kind: 'v2' }] },
}));

import { getProjectsWithSprints } from './useProjectsCache';
import { intentsService } from '@/services/intents';

const intent = (id: string, status: string) => ({
  id,
  title: id,
  status,
  createdAt: '2026-11-01T00:00:00Z',
  updatedAt: '2026-11-01T00:00:00Z',
});

describe('useProjectsCache — intent writes', () => {
  let listed: ReturnType<typeof intent>[];

  beforeEach(() => {
    listed = [intent('i1', 'RUNNING')];
    get.mockReset().mockImplementation(async (path: string) => {
      if (path === '/projects/p1/intents') return listed;
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockReset();
    del.mockReset();
  });

  it('re-reads the spaces cache after a successful create, cancel and delete', async () => {
    const titles = async () => (await getProjectsWithSprints())[0].intents.map((i) => i.id);
    const statuses = async () => (await getProjectsWithSprints())[0].intents.map((i) => i.status);
    expect(await titles()).toEqual(['i1']);

    listed = [intent('i1', 'RUNNING'), intent('i2', 'DRAFT')];
    post.mockResolvedValueOnce(intent('i2', 'DRAFT'));
    await intentsService.create('p1', { title: 'i2' } as never);
    await vi.waitFor(async () => expect(await titles()).toEqual(['i1', 'i2']));

    listed = [intent('i1', 'CANCELLED'), intent('i2', 'DRAFT')];
    post.mockResolvedValueOnce(intent('i1', 'CANCELLED'));
    await intentsService.cancel('p1', 'i1');
    await vi.waitFor(async () => expect(await statuses()).toEqual(['CANCELLED', 'DRAFT']));

    listed = [intent('i1', 'CANCELLED')];
    del.mockResolvedValueOnce(undefined);
    await intentsService.delete('p1', 'i2');
    await vi.waitFor(async () => expect(await titles()).toEqual(['i1']));
  });

  it('keeps the cached list when the write fails', async () => {
    await getProjectsWithSprints();
    const reads = get.mock.calls.length;
    post.mockRejectedValueOnce(new Error('409'));
    await expect(intentsService.create('p1', { title: 'x' } as never)).rejects.toThrow('409');
    await Promise.resolve();
    expect(get.mock.calls.length).toBe(reads);
  });
});
