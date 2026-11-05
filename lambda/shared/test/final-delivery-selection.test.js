import { describe, expect, it } from 'vitest';
import { selectDeliveryPr } from '../final-delivery.js';
import { deliveryMarkers, newDeliveryMarker, withDeliveryMarker } from '../delivery-marker.js';

const ours = newDeliveryMarker();
const theirs = newDeliveryMarker();
const pr = (number, state, { target = 'develop', markers = [], source = 'intent' } = {}) => ({
  number,
  state,
  sourceBranch: source,
  targetBranch: target,
  markers,
});
const select = (pullRequests, { requested, marker = requested ? ours : null }) =>
  selectDeliveryPr(pullRequests, { branch: 'intent', baseBranch: 'develop', marker, requested });

describe('delivery marker', () => {
  it('is random, carries no input data and survives in a description', () => {
    expect(ours).toMatch(/^aidlc-delivery-[0-9a-f]{32}$/);
    expect(ours).not.toBe(theirs);
    const body = withDeliveryMarker('Automated PR', ours);
    expect(body.startsWith('Automated PR')).toBe(true);
    expect(deliveryMarkers(body)).toEqual([ours]);
    expect(deliveryMarkers(`${body}\n${body}`)).toEqual([ours]);
    expect(deliveryMarkers(null)).toEqual([]);
  });
});

// Every row of the decision table in final-delivery.js, without and with a
// recorded create request, and in each listing order.
describe.each([false, true])('PR ownership decision (create request recorded=%s)', (requested) => {
  const both = (list) => [list, [...list].reverse()];
  it('reuses an open PR onto the captured target whatever its marker', () => {
    for (const list of both([
      pr(1, 'closed', { markers: [theirs] }),
      pr(2, 'open', { markers: [theirs] }),
      pr(3, 'merged'),
    ]))
      expect(select(list, { requested })).toEqual({
        kind: 'open',
        pr: list.find((p) => p.number === 2),
      });
  });
  it('refuses an open PR onto another target only', () => {
    expect(select([pr(1, 'open', { target: 'main' }), pr(2, 'closed')], { requested })).toEqual({
      kind: 'retargeted',
    });
  });
  it("ignores closed and merged PRs carrying another run's marker", () => {
    for (const list of both([
      pr(1, 'closed', { markers: [theirs] }),
      pr(2, 'merged', { markers: [theirs] }),
    ]))
      expect(select(list, { requested })).toEqual({ kind: 'none' });
  });
  it('treats unmarked closed or merged PRs as uncertain only after a recorded request', () => {
    for (const list of both([pr(1, 'closed'), pr(2, 'merged', { markers: [theirs] })]))
      expect(select(list, { requested })).toEqual({ kind: requested ? 'uncertain' : 'none' });
  });
  it('publishes when the branch has no pull request', () => {
    expect(select([], { requested })).toEqual({ kind: 'none' });
  });
  it("ignores PRs from other branches and another run's closed PRs onto other targets", () => {
    expect(
      select(
        [
          pr(1, 'open', { source: 'other' }),
          pr(2, 'closed', { source: 'other', markers: [ours] }),
          pr(3, 'closed', { target: 'main', markers: [theirs] }),
        ],
        { requested },
      ),
    ).toEqual({ kind: 'none' });
  });
});

describe('PR ownership by this row marker', () => {
  it.each(['closed', 'merged'])('finds its own %s PR among earlier ones in any order', (state) => {
    const own = pr(5, state, { markers: [ours] });
    const earlier = [pr(1, 'closed', { markers: [theirs] }), pr(2, 'merged'), pr(3, 'closed')];
    for (const list of [
      [own, ...earlier],
      [...earlier, own],
    ])
      expect(select(list, { requested: true })).toEqual({ kind: 'own', pr: own });
  });
  it('is uncertain when two closed PRs carry this marker', () => {
    expect(
      select([pr(1, 'closed', { markers: [ours] }), pr(2, 'merged', { markers: [ours, theirs] })], {
        requested: true,
      }),
    ).toEqual({ kind: 'uncertain' });
  });
  it('never treats a marked PR as its own without a recorded marker (rows from earlier heads)', () => {
    expect(
      select([pr(1, 'closed', { markers: [ours] })], { requested: true, marker: null }),
    ).toEqual({ kind: 'none' });
    expect(select([pr(1, 'closed')], { requested: true, marker: null })).toEqual({
      kind: 'uncertain',
    });
  });
});

// A pull request this run created keeps its marker when a reviewer retargets
// it, so the target never decides ownership; it only decides the outcome.
describe('PR ownership across targets', () => {
  it.each(['closed', 'merged'])(
    'refuses its own %s PR after it was retargeted instead of publishing again',
    (state) => {
      const own = pr(4, state, { target: 'main', markers: [ours] });
      for (const list of [
        [own, pr(1, 'closed', { markers: [theirs] })],
        [pr(1, 'closed', { markers: [theirs] }), own],
      ])
        expect(select(list, { requested: true })).toEqual({ kind: 'retargeted', pr: own });
    },
  );
  it('ignores a marked PR on another target when this row has no marker or request', () => {
    expect(
      select([pr(1, 'closed', { target: 'main', markers: [theirs] })], { requested: false }),
    ).toEqual({ kind: 'none' });
  });
  it('is uncertain when proven PRs exist on two different targets', () => {
    expect(
      select(
        [
          pr(1, 'closed', { target: 'main', markers: [ours] }),
          pr(2, 'merged', { target: 'release', markers: [ours] }),
        ],
        { requested: true },
      ),
    ).toEqual({ kind: 'uncertain' });
    expect(
      select(
        [
          pr(1, 'closed', { markers: [ours] }),
          pr(2, 'merged', { target: 'main', markers: [ours] }),
        ],
        { requested: true },
      ),
    ).toEqual({ kind: 'uncertain' });
  });
  it('still resolves a single proven PR on the captured target as its own', () => {
    const own = pr(3, 'merged', { markers: [ours] });
    expect(
      select([pr(1, 'closed', { target: 'main', markers: [theirs] }), own], { requested: true }),
    ).toEqual({ kind: 'own', pr: own });
  });
  it('treats an unmarked closed PR on another target as uncertain after a recorded request', () => {
    const list = [pr(1, 'closed', { target: 'main' })];
    expect(select(list, { requested: true })).toEqual({ kind: 'uncertain' });
    expect(select(list, { requested: false })).toEqual({ kind: 'none' });
  });
  it('counts a row marker as a recorded request', () => {
    expect(
      selectDeliveryPr([pr(1, 'closed')], {
        branch: 'intent',
        baseBranch: 'develop',
        marker: ours,
        requested: false,
      }),
    ).toEqual({ kind: 'uncertain' });
  });
});
