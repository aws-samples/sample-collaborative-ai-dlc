import { describe, expect, it } from 'vitest';
import { deriveSpaceSignals, hasOpenWork, spaceSignalParts } from './spaceSignals';
import type { ProjectIntentSummary } from '@/hooks/useProjectsCache';

const NOW = new Date('2026-11-21T12:00:00Z').getTime();
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

const intent = (
  id: string,
  status: ProjectIntentSummary['status'],
  updatedAt: string,
  extra: Partial<ProjectIntentSummary> = {},
): ProjectIntentSummary => ({
  id,
  title: id,
  status,
  createdAt: updatedAt,
  updatedAt,
  completedAt: null,
  scope: 'feature',
  pendingHumanTaskId: null,
  resumeRequired: false,
  ...extra,
});

describe('deriveSpaceSignals', () => {
  it('counts questions and resumes, failures, live runs and stalled runs; finished work is not open work', () => {
    const signals = deriveSpaceSignals(
      [
        intent('q', 'WAITING', hoursAgo(1), { pendingHumanTaskId: 't' }),
        intent('resume', 'WAITING', hoursAgo(1), { resumeRequired: true }),
        intent('auto', 'WAITING', hoursAgo(1)),
        intent('f', 'FAILED', hoursAgo(1)),
        intent('live', 'RUNNING', hoursAgo(0.1)),
        intent('created', 'CREATED', hoursAgo(0.1)),
        intent('stuck', 'RUNNING', hoursAgo(5)),
        intent('done', 'SUCCEEDED', hoursAgo(1)),
        intent('dropped', 'CANCELLED', hoursAgo(1)),
      ],
      NOW,
    );
    expect(signals).toEqual({ questions: 2, failed: 1, running: 2, stalled: 1 });
    expect(hasOpenWork(signals)).toBe(true);
    expect(spaceSignalParts(signals)).toEqual([
      '2 questions',
      '1 failed',
      '1 stalled',
      '2 running',
    ]);
  });

  it('reports no open work for a space with only finished intents', () => {
    const signals = deriveSpaceSignals([intent('done', 'SUCCEEDED', hoursAgo(1))], NOW);
    expect(hasOpenWork(signals)).toBe(false);
    expect(spaceSignalParts(signals)).toEqual([]);
  });
});
