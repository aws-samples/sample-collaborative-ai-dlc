import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@/test/query';
import { queryClient } from '@/lib/queryClient';

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

import { useProjectsCache } from './useProjectsCache';
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
    queryClient.clear();
    sessionStorage.clear();
    listed = [intent('i1', 'RUNNING')];
    get.mockReset().mockImplementation(async (path: string) => {
      if (path === '/projects/p1/intents') return listed;
      throw new Error(`unexpected GET ${path}`);
    });
    post.mockReset();
    del.mockReset();
  });

  it('re-reads the shown space list after a successful create, cancel and delete', async () => {
    const { result } = renderHook(() => useProjectsCache());
    const ids = () => result.current.projects[0]?.intents.map((i) => `${i.id}:${i.status}`);
    await waitFor(() => expect(ids()).toEqual(['i1:RUNNING']));

    listed = [intent('i1', 'RUNNING'), intent('i2', 'DRAFT')];
    post.mockResolvedValueOnce(intent('i2', 'DRAFT'));
    await intentsService.create('p1', { title: 'i2' } as never);
    await waitFor(() => expect(ids()).toEqual(['i1:RUNNING', 'i2:DRAFT']));

    listed = [intent('i1', 'CANCELLED'), intent('i2', 'DRAFT')];
    post.mockResolvedValueOnce(intent('i1', 'CANCELLED'));
    await intentsService.cancel('p1', 'i1');
    await waitFor(() => expect(ids()).toEqual(['i1:CANCELLED', 'i2:DRAFT']));

    listed = [intent('i1', 'CANCELLED')];
    del.mockResolvedValueOnce(undefined);
    await intentsService.delete('p1', 'i2');
    await waitFor(() => expect(ids()).toEqual(['i1:CANCELLED']));
  });

  it('keeps the shown list when the write fails', async () => {
    const { result } = renderHook(() => useProjectsCache());
    await waitFor(() => expect(result.current.projects[0]?.intents).toHaveLength(1));
    const reads = get.mock.calls.length;
    post.mockRejectedValueOnce(new Error('409'));
    await expect(intentsService.create('p1', { title: 'x' } as never)).rejects.toThrow('409');
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get.mock.calls.length).toBe(reads);
  });
});
