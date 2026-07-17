import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('./api', () => ({
  api: { get: (...a: unknown[]) => get(...a), post: (...a: unknown[]) => post(...a) },
}));

import { intentsService } from './intents';

describe('intentsService request paths', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([]);
    post.mockReset().mockResolvedValue({});
  });

  it('list / list?status', async () => {
    await intentsService.list('p1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents');
    await intentsService.list('p1', 'RUNNING');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents?status=RUNNING');
  });

  it('get / create / start / answerGate', async () => {
    await intentsService.get('p1', 'i1');
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1');

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
});
