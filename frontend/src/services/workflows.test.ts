import { beforeEach, describe, expect, it, vi } from 'vitest';

const get = vi.fn();
const post = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...args: unknown[]) => get(...args),
    post: (...args: unknown[]) => post(...args),
  },
}));

import { workflowsService } from './workflows';

describe('workflowsService existing-intent release context', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue({});
    post.mockReset().mockResolvedValue({});
  });

  it('adds project and intent identity to release-backed compiled reads', async () => {
    await workflowsService.compiled('aidlc-v2', 1, 'aidlc:old', 1, {
      projectId: 'p1',
      intentId: 'i1',
    });

    expect(get).toHaveBeenCalledWith(
      '/workflows/aidlc-v2/compiled?version=1&release=aidlc%3Aold&releaseImporterRevision=1&projectId=p1&intentId=i1',
    );
  });

  it('adds existing-intent identity to execution previews and grid validation', async () => {
    const intent = { projectId: 'p1', intentId: 'i1' };
    await workflowsService.executionPreview(
      'aidlc-v2',
      'feature',
      1,
      ['design'],
      'aidlc:old',
      1,
      intent,
    );
    expect(get).toHaveBeenCalledWith(
      '/workflows/aidlc-v2/execution-preview?scope=feature&version=1&skip=design&release=aidlc%3Aold&releaseImporterRevision=1&projectId=p1&intentId=i1',
    );

    await workflowsService.validateGrid('aidlc-v2', {
      composedGrid: { design: 'EXECUTE' },
      version: 1,
      release: 'aidlc:old',
      releaseImporterRevision: 1,
      ...intent,
    });
    expect(post).toHaveBeenCalledWith(
      '/workflows/aidlc-v2/validate-grid?version=1&release=aidlc%3Aold&releaseImporterRevision=1&projectId=p1&intentId=i1',
      { composedGrid: { design: 'EXECUTE' } },
    );
  });
});
