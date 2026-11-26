import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
vi.mock('./api', () => ({
  api: { get: (...a: unknown[]) => get(...a) },
  ApiError: class ApiError extends Error {},
}));

import { sourceControlService } from './sourceControl';

const pageOf = (path: string) => new URLSearchParams(path.split('?')[1]).get('page');

describe('sourceControlService.listBranches', () => {
  beforeEach(() => get.mockReset());

  it('reads every page of branches, one request each, with the default branch from page 1', async () => {
    get
      .mockResolvedValueOnce({ branches: ['main'], defaultBranch: 'main', nextPage: 2 })
      .mockResolvedValueOnce({ branches: ['release/101'], nextPage: null });

    const result = await sourceControlService.listBranches('p1', 'github', 'acme/api');

    expect(result).toEqual({ branches: ['main', 'release/101'], defaultBranch: 'main' });
    expect(get.mock.calls.map(([path]) => pageOf(path))).toEqual(['1', '2']);
    expect(get.mock.calls[0][0]).toContain('provider=github&repository=acme%2Fapi');
  });

  it('keeps the branches already read when a later page fails', async () => {
    get
      .mockResolvedValueOnce({ branches: ['main'], nextPage: 2 })
      .mockRejectedValueOnce(new Error('Gateway Timeout'));

    expect(await sourceControlService.listBranches('p1', 'github', 'acme/api')).toEqual({
      branches: ['main'],
    });
  });

  it('stops after 10 pages, the first 1,000 branches', async () => {
    get.mockImplementation(async (...args: unknown[]) => {
      const page = Number(pageOf(String(args[0])));
      return { branches: [`b${page}`], nextPage: page + 1 };
    });

    expect(
      (await sourceControlService.listBranches('p1', 'github', 'acme/api')).branches,
    ).toHaveLength(10);
    expect(get).toHaveBeenCalledTimes(10);
  });

  it('fails when page 1 fails', async () => {
    get.mockRejectedValueOnce(new Error('Source-control provider operation failed'));

    await expect(sourceControlService.listBranches('p1', 'gitlab', 'g/p')).rejects.toThrow(
      'Source-control provider operation failed',
    );
  });
});
