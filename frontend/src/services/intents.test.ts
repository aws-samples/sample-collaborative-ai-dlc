import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const del = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    delete: (...a: unknown[]) => del(...a),
  },
}));

import { intentsService } from './intents';

describe('intentsService request paths', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([]);
    post.mockReset().mockResolvedValue({});
    del.mockReset().mockResolvedValue(undefined);
  });

  it('uses intent-scoped attachment routes', async () => {
    await intentsService.attachments('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/attachments');

    const files = [{ filename: 'notes.md', mimeType: 'text/markdown', size: 12 }];
    await intentsService.attachmentUploadUrls('p1', 'i1', files);
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/attachments/upload', {
      attachments: files,
    });

    await intentsService.deleteAttachment('p1', 'i1', 'a/b', 3);
    expect(del).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/attachments/a%2Fb?attachmentRevision=3',
    );
  });

  it('list / list?status', async () => {
    await intentsService.list('p1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents');
    await intentsService.list('p1', 'RUNNING');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents?status=RUNNING');
  });

  it('get / create / start / answerGate', async () => {
    await intentsService.get('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1?artifactContent=separate');

    await intentsService.create('p1', { title: 'T', prompt: 'P' });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents', { title: 'T', prompt: 'P' });

    await intentsService.start('p1', 'i1');
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/start', {});

    await intentsService.repair('p1', 'i1');
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/repair', {});

    await intentsService.answerGate('p1', 'i1', 'h1', { answer: { ok: 1 } });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/gates/h1/answer', {
      answer: { ok: 1 },
    });
  });

  it('outputs — lazy transcript with pane + cursor params', async () => {
    await intentsService.outputs('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/outputs');

    await intentsService.outputs('p1', 'i1', { stageInstanceId: 'si-1', afterSeq: 42 });
    expect(get).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/outputs?stageInstanceId=si-1&afterSeq=42',
    );

    // The workspace/init pane key is passed through literally.
    await intentsService.outputs('p1', 'i1', { stageInstanceId: 'intent' });
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/outputs?stageInstanceId=intent');
  });

  it('loads artifact history and encodes artifact and version ids', async () => {
    await intentsService.artifactVersions('p1', 'i1', 'design/head');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/artifacts/design%2Fhead/versions');

    await intentsService.artifactVersion('p1', 'i1', 'design/head', 'design/head:v1');
    expect(get).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/artifacts/design%2Fhead/versions/design%2Fhead%3Av1',
    );
  });

  it('get / list pass an optional signal through, otherwise the plain GET', async () => {
    const controller = new AbortController();
    await intentsService.get('p1', 'i1', { signal: controller.signal });
    expect(get).toHaveBeenLastCalledWith('/projects/p1/intents/i1?artifactContent=separate', {
      signal: controller.signal,
    });
    await intentsService.list('p1', undefined, { signal: controller.signal });
    expect(get).toHaveBeenLastCalledWith('/projects/p1/intents', { signal: controller.signal });
    await intentsService.list('p1', 'WAITING');
    expect(get.mock.calls.at(-1)).toEqual(['/projects/p1/intents?status=WAITING']);
  });
});

describe('intentsService list invalidation', () => {
  beforeEach(async () => {
    const { queryClient } = await import('@/lib/queryClient');
    queryClient.clear();
    post.mockReset().mockResolvedValue({ id: 'new' });
    del.mockReset().mockResolvedValue(undefined);
  });

  it('makes a fresh cached space list re-read after create, cancel, start and delete succeed', async () => {
    const { queryClient } = await import('@/lib/queryClient');
    const { qk } = await import('@/lib/queryKeys');
    const fetcher = vi.fn().mockResolvedValue([{ id: 'old' }]);
    const listQuery = { queryKey: qk.projectIntents('p1'), queryFn: fetcher };
    const waitingQuery = {
      queryKey: [...qk.projectIntents('p1'), 'status', 'WAITING'],
      queryFn: vi.fn().mockResolvedValue([]),
    };

    for (const write of [
      () => intentsService.create('p1', { title: 'New' } as never),
      () => intentsService.cancel('p1', 'i1'),
      () => intentsService.start('p1', 'i1'),
      () => intentsService.delete('p1', 'i1'),
    ]) {
      await queryClient.fetchQuery(listQuery);
      await queryClient.fetchQuery(waitingQuery);
      const before = fetcher.mock.calls.length;
      // Fresh: the Space would not refetch on its own.
      await queryClient.fetchQuery(listQuery);
      expect(fetcher.mock.calls.length).toBe(before);

      await write();

      expect(queryClient.getQueryState(qk.projectIntents('p1'))?.isInvalidated).toBe(true);
      expect(queryClient.getQueryState(waitingQuery.queryKey)?.isInvalidated).toBe(true);
      await queryClient.fetchQuery(listQuery);
      expect(fetcher.mock.calls.length).toBe(before + 1);
    }
  });

  it('keeps the cached list when the write fails', async () => {
    const { queryClient } = await import('@/lib/queryClient');
    const { qk } = await import('@/lib/queryKeys');
    const fetcher = vi.fn().mockResolvedValue([{ id: 'old' }]);
    await queryClient.fetchQuery({ queryKey: qk.projectIntents('p1'), queryFn: fetcher });
    post.mockRejectedValueOnce(new Error('409'));

    await expect(intentsService.create('p1', { title: 'New' } as never)).rejects.toThrow('409');

    expect(queryClient.getQueryState(qk.projectIntents('p1'))?.isInvalidated).toBe(false);
  });
});
