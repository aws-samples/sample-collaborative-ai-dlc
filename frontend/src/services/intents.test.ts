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

    await intentsService.answerGate('p1', 'i1', 'h1', { answer: { ok: 1 } });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/gates/h1/answer', {
      answer: { ok: 1 },
    });
  });
});
