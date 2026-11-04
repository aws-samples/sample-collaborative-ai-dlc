import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('./api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./api')>();
  return { ...actual, api: { get: (...a: unknown[]) => get(...a) } };
});

import { myWorkService } from './myWork';
import { ApiError } from './api';

describe('myWorkService.listPendingQuestions', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({ items: [], nextCursor: null, unavailable: [] });
  });

  it('omits unset params', async () => {
    await myWorkService.listPendingQuestions();
    expect(get).toHaveBeenCalledWith('/users/me/pending-questions');
    await myWorkService.listPendingQuestions({ cursor: null, projectId: null, kinds: [] });
    expect(get).toHaveBeenLastCalledWith('/users/me/pending-questions');
  });

  it('joins kinds with commas and encodes the cursor', async () => {
    await myWorkService.listPendingQuestions({
      limit: 25,
      cursor: 'a+b/c=',
      projectId: 'p 1',
      kinds: ['approval', 'review-verdict', 'validation'],
    });
    expect(get).toHaveBeenCalledWith(
      '/users/me/pending-questions?limit=25&cursor=a%2Bb%2Fc%3D&projectId=p+1&kind=approval%2Creview-verdict%2Cvalidation',
    );
  });

  it('surfaces API errors as ApiError', async () => {
    get.mockRejectedValue(new ApiError(403, 'Not a project member', { code: 'NOT_A_MEMBER' }));
    await expect(myWorkService.listPendingQuestions({ projectId: 'p9' })).rejects.toMatchObject({
      status: 403,
      body: { code: 'NOT_A_MEMBER' },
    });
  });
});
