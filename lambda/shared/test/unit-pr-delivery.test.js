import { describe, it, expect, vi } from 'vitest';
import { mergedUnitPrDelivered } from '../unit-pr-delivery.js';

const merged = (overrides = {}) => ({
  state: 'merged',
  headSha: 'accepted',
  mergeResultSha: 'squash-commit',
  ...overrides,
});
// The provider answers from a fixed set of commits on the target branch.
const onTarget =
  (...shas) =>
  async (sha) =>
    shas.includes(sha);

describe('mergedUnitPrDelivered', () => {
  it('accepts a merge commit merge: the accepted head is on the target', async () => {
    const isAncestor = vi.fn(onTarget('accepted'));
    await expect(
      mergedUnitPrDelivered({
        acceptedHeadSha: 'accepted',
        status: merged({ mergeResultSha: 'merge-commit' }),
        targetRef: 'aidlc/i1',
        isAncestor,
      }),
    ).resolves.toBe(true);
    expect(isAncestor).toHaveBeenCalledOnce();
    expect(isAncestor).toHaveBeenCalledWith('accepted', 'aidlc/i1');
  });

  it('accepts a squash or rebase merge whose result commit is on the target', async () => {
    const isAncestor = vi.fn(onTarget('squash-commit'));
    await expect(
      mergedUnitPrDelivered({
        acceptedHeadSha: 'accepted',
        status: merged(),
        targetRef: 'aidlc/i1',
        isAncestor,
      }),
    ).resolves.toBe(true);
    expect(isAncestor).toHaveBeenNthCalledWith(2, 'squash-commit', 'aidlc/i1');
  });

  it('refuses a merge result that is not on the target', async () => {
    await expect(
      mergedUnitPrDelivered({
        acceptedHeadSha: 'accepted',
        status: merged(),
        targetRef: 'aidlc/i1',
        isAncestor: onTarget(),
      }),
    ).resolves.toBe(false);
  });

  it('refuses a merge result when the PR head moved after acceptance', async () => {
    const isAncestor = vi.fn(onTarget('squash-commit'));
    await expect(
      mergedUnitPrDelivered({
        acceptedHeadSha: 'accepted',
        status: merged({ headSha: 'pushed-later' }),
        targetRef: 'aidlc/i1',
        isAncestor,
      }),
    ).resolves.toBe(false);
    expect(isAncestor).not.toHaveBeenCalledWith('squash-commit', 'aidlc/i1');
  });

  it('refuses a merged PR with no merge result and no accepted head on the target', async () => {
    await expect(
      mergedUnitPrDelivered({
        acceptedHeadSha: 'accepted',
        status: merged({ mergeResultSha: null }),
        targetRef: 'aidlc/i1',
        isAncestor: onTarget('anything-else'),
      }),
    ).resolves.toBe(false);
  });

  it('refuses without an accepted head or a merged state, asking the provider nothing', async () => {
    const isAncestor = vi.fn(onTarget('accepted', 'squash-commit'));
    for (const args of [
      { acceptedHeadSha: null, status: merged() },
      { acceptedHeadSha: 'accepted', status: merged({ state: 'open' }) },
      { acceptedHeadSha: 'accepted', status: null },
    ]) {
      await expect(
        mergedUnitPrDelivered({ ...args, targetRef: 'aidlc/i1', isAncestor }),
      ).resolves.toBe(false);
    }
    expect(isAncestor).not.toHaveBeenCalled();
  });

  it('lets a provider failure propagate', async () => {
    await expect(
      mergedUnitPrDelivered({
        acceptedHeadSha: 'accepted',
        status: merged(),
        targetRef: 'aidlc/i1',
        isAncestor: async () => {
          throw new Error('provider unavailable');
        },
      }),
    ).rejects.toThrow('provider unavailable');
  });
});
