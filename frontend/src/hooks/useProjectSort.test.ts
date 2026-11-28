import { beforeEach, describe, expect, it } from 'vitest';
import {
  intentAttentionRank,
  projectAttentionRank,
  projectComparator,
  PROJECT_SORT_LABELS,
  setProjectSort,
} from './useProjectSort';

describe('intentAttentionRank', () => {
  it('ranks questions and resumes first, failures second, everything else last', () => {
    expect(intentAttentionRank({ status: 'WAITING', pendingHumanTaskId: 'task-1' })).toBe(0);
    expect(intentAttentionRank({ status: 'WAITING', resumeRequired: true })).toBe(0);
    expect(intentAttentionRank({ status: 'FAILED' })).toBe(1);
    expect(intentAttentionRank({ status: 'WAITING' })).toBe(2);
    expect(intentAttentionRank({ status: 'RUNNING' })).toBe(2);
    expect(intentAttentionRank({ status: 'SUCCEEDED' })).toBe(2);
  });

  it('gives a space the rank of its most urgent intent', () => {
    expect(projectAttentionRank([])).toBe(2);
    expect(projectAttentionRank([{ status: 'RUNNING' }, { status: 'FAILED' }])).toBe(1);
    expect(
      projectAttentionRank([{ status: 'FAILED' }, { status: 'WAITING', pendingHumanTaskId: 't' }]),
    ).toBe(0);
  });
});

describe('projectComparator', () => {
  const quiet = { name: 'Quiet', createdAt: '2026-01-05', lastActivityAt: '2026-03-01' };
  const failed = {
    name: 'Failed',
    createdAt: '2026-01-04',
    lastActivityAt: '2026-02-01',
    attentionRank: 1,
  };
  const asks = {
    name: 'Asks',
    createdAt: '2026-01-03',
    lastActivityAt: '2026-01-10',
    attentionRank: 0,
  };
  const asksRecent = {
    name: 'Asks recent',
    createdAt: '2026-01-02',
    lastActivityAt: '2026-02-20',
    attentionRank: 0,
  };

  it('puts spaces waiting on a human first, then failures, then the rest by activity', () => {
    const sorted = [quiet, failed, asks, asksRecent].toSorted(projectComparator('attention'));
    expect(sorted.map((p) => p.name)).toEqual(['Asks recent', 'Asks', 'Failed', 'Quiet']);
  });

  it('treats a missing rank as "nothing waiting" so partial callers still sort by activity', () => {
    const sorted = [quiet, failed].toSorted(projectComparator('attention'));
    expect(sorted.map((p) => p.name)).toEqual(['Failed', 'Quiet']);
    const noRanks = [quiet, { ...failed, attentionRank: undefined }];
    expect(noRanks.toSorted(projectComparator('attention')).map((p) => p.name)).toEqual([
      'Quiet',
      'Failed',
    ]);
  });

  it('keeps the other orders', () => {
    const all = [quiet, failed, asks];
    expect(all.toSorted(projectComparator('activity')).map((p) => p.name)).toEqual([
      'Quiet',
      'Failed',
      'Asks',
    ]);
    expect(all.toSorted(projectComparator('created')).map((p) => p.name)).toEqual([
      'Quiet',
      'Failed',
      'Asks',
    ]);
    expect(all.toSorted(projectComparator('name')).map((p) => p.name)).toEqual([
      'Asks',
      'Failed',
      'Quiet',
    ]);
  });
});

describe('sort labels and persistence', () => {
  beforeEach(() => localStorage.clear());

  it('labels the attention order like the Space page', () => {
    expect(PROJECT_SORT_LABELS.attention).toBe('Needs attention first');
  });

  it('persists the chosen sort', () => {
    setProjectSort('name');
    expect(localStorage.getItem('aidlc.projectSort')).toBe('name');
    setProjectSort('attention');
    expect(localStorage.getItem('aidlc.projectSort')).toBe('attention');
  });
});
