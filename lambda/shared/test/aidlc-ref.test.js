import { describe, expect, it, vi } from 'vitest';
import { isCommitSha, resolveAidlcRepoRef } from '../aidlc-ref.js';

const SHA = 'ABCDEF0123456789ABCDEF0123456789ABCDEF01';

describe('AI-DLC repository refs', () => {
  it('accepts and normalizes an existing commit SHA without a network call', async () => {
    const fetchFn = vi.fn();
    await expect(resolveAidlcRepoRef(SHA, { fetchFn })).resolves.toBe(SHA.toLowerCase());
    expect(fetchFn).not.toHaveBeenCalled();
    expect(isCommitSha(SHA)).toBe(true);
  });

  it('resolves a branch or tag through the GitHub commits API', async () => {
    const fetchFn = vi.fn(async () => ({
      ok: true,
      json: async () => ({ sha: SHA }),
    }));
    await expect(resolveAidlcRepoRef('release/v2', { fetchFn })).resolves.toBe(SHA.toLowerCase());
    expect(fetchFn.mock.calls[0][0]).toContain('/commits/release%2Fv2');
  });

  it('rejects refs that cannot be resolved to a commit', async () => {
    const fetchFn = vi.fn(async () => ({ ok: false, status: 404 }));
    await expect(resolveAidlcRepoRef('missing', { fetchFn })).rejects.toThrow(/404/);
  });
});
