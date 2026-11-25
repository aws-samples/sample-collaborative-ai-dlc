import { describe, expect, it } from 'vitest';
import {
  intentGroup,
  isUntitledIntent,
  matchesSpaceFilter,
  needsAttention,
  orderIntents,
  parseSpaceFilter,
  type GroupableIntent,
} from './intentGrouping';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function intent(
  id: string,
  status: GroupableIntent['status'],
  updatedAt: string,
  extra: Partial<GroupableIntent> = {},
): GroupableIntent {
  return { id, title: `Intent ${id}`, status, createdAt: updatedAt, updatedAt, ...extra };
}

describe('intentGroup', () => {
  it('ranks human decisions first, then failures, live work, drafts, finished', () => {
    expect(intentGroup(intent('q', 'WAITING', hoursAgo(1), { pendingHumanTaskId: 't' }))).toBe(
      'attention',
    );
    expect(
      intentGroup(
        intent('r', 'WAITING', hoursAgo(1), {
          resumeRequired: { humanTaskId: 't', callbackId: 'c', answeredAt: null },
        }),
      ),
    ).toBe('attention');
    expect(intentGroup(intent('f', 'FAILED', hoursAgo(1)))).toBe('failed');
    expect(intentGroup(intent('run', 'RUNNING', hoursAgo(1)))).toBe('active');
    expect(intentGroup(intent('new', 'CREATED', hoursAgo(1)))).toBe('active');
    expect(intentGroup(intent('auto', 'WAITING', hoursAgo(1), { pendingHumanTaskId: null }))).toBe(
      'active',
    );
    expect(intentGroup(intent('d', 'DRAFT', hoursAgo(1)))).toBe('draft');
    expect(intentGroup(intent('ok', 'SUCCEEDED', hoursAgo(1)))).toBe('finished');
    expect(intentGroup(intent('stop', 'CANCELLED', hoursAgo(1)))).toBe('finished');
  });

  it('keeps a stalled run in the active group (it is not finished)', () => {
    expect(intentGroup(intent('hung', 'RUNNING', hoursAgo(24 * 120)))).toBe('active');
  });
});

describe('orderIntents (attention sort)', () => {
  const rows = [
    intent('cancelled-recent', 'CANCELLED', hoursAgo(1)),
    intent('running-old', 'RUNNING', hoursAgo(24 * 120)),
    intent('done-recent', 'SUCCEEDED', hoursAgo(2)),
    intent('draft', 'DRAFT', hoursAgo(3)),
    intent('question-old', 'WAITING', hoursAgo(24 * 108), { pendingHumanTaskId: 'gate-1' }),
    intent('running-fresh', 'RUNNING', hoursAgo(0.1)),
    intent('failed', 'FAILED', hoursAgo(24 * 57)),
    intent('question-new', 'WAITING', hoursAgo(5), { pendingHumanTaskId: 'gate-2' }),
  ];

  it('orders every needs-input row before failures, before active work, before drafts, before finished', () => {
    const ordered = orderIntents(rows, 'attention', NOW);
    const groups = ordered.map((row) => intentGroup(row, NOW));
    const rank = ['attention', 'failed', 'active', 'draft', 'finished'];
    const ranks = groups.map((g) => rank.indexOf(g));
    expect(ranks).toEqual(ranks.toSorted((a, b) => a - b));
    // Recent cancellations never precede running work.
    expect(ordered.findIndex((r) => r.id === 'running-old')).toBeLessThan(
      ordered.findIndex((r) => r.id === 'cancelled-recent'),
    );
  });

  it('sorts by latest activity (newest first) inside a group', () => {
    const ids = orderIntents(rows, 'attention', NOW).map((row) => row.id);
    expect(ids.indexOf('question-new')).toBeLessThan(ids.indexOf('question-old'));
    expect(ids.indexOf('running-fresh')).toBeLessThan(ids.indexOf('running-old'));
    expect(ids.indexOf('cancelled-recent')).toBeLessThan(ids.indexOf('done-recent'));
  });

  it('supports plain chronological and title sorts', () => {
    expect(orderIntents(rows, 'updated', NOW)[0].id).toBe('running-fresh');
    expect(orderIntents(rows, 'title', NOW).map((row) => row.id)[0]).toBe('cancelled-recent');
  });
});

describe('space filters', () => {
  it('parses the dashboard query values and ignores unknown ones', () => {
    expect(parseSpaceFilter('needs-attention')).toBe('needs-attention');
    expect(parseSpaceFilter('failed')).toBe('failed');
    expect(parseSpaceFilter('active')).toBe('active');
    expect(parseSpaceFilter('finished')).toBe('finished');
    expect(parseSpaceFilter('bogus')).toBe('all');
    expect(parseSpaceFilter(null)).toBe('all');
  });

  it('matches groups to filters', () => {
    const question = intent('q', 'WAITING', hoursAgo(1), { pendingHumanTaskId: 't' });
    const failed = intent('f', 'FAILED', hoursAgo(1));
    const running = intent('r', 'RUNNING', hoursAgo(0.1));
    const draft = intent('d', 'DRAFT', hoursAgo(1));
    const done = intent('ok', 'SUCCEEDED', hoursAgo(1));
    expect(matchesSpaceFilter(question, 'needs-attention', NOW)).toBe(true);
    expect(matchesSpaceFilter(failed, 'needs-attention', NOW)).toBe(true);
    expect(matchesSpaceFilter(running, 'needs-attention', NOW)).toBe(false);
    const stalled = intent('hung', 'RUNNING', hoursAgo(24 * 120));
    expect(needsAttention(stalled, NOW)).toBe(true);
    expect(matchesSpaceFilter(stalled, 'needs-attention', NOW)).toBe(true);
    expect(matchesSpaceFilter(stalled, 'active', NOW)).toBe(true);
    expect(matchesSpaceFilter(stalled, 'failed', NOW)).toBe(false);
    expect(matchesSpaceFilter(failed, 'failed', NOW)).toBe(true);
    expect(matchesSpaceFilter(question, 'failed', NOW)).toBe(false);
    expect(matchesSpaceFilter(running, 'active', NOW)).toBe(true);
    expect(matchesSpaceFilter(question, 'active', NOW)).toBe(true);
    expect(matchesSpaceFilter(failed, 'active', NOW)).toBe(false);
    expect(matchesSpaceFilter(draft, 'active', NOW)).toBe(false);
    expect(matchesSpaceFilter(done, 'finished', NOW)).toBe(true);
    expect(matchesSpaceFilter(done, 'all', NOW)).toBe(true);
  });
});

describe('isUntitledIntent', () => {
  it('treats empty and placeholder titles as untitled', () => {
    expect(isUntitledIntent(null)).toBe(true);
    expect(isUntitledIntent('   ')).toBe(true);
    expect(isUntitledIntent('Title')).toBe(true);
    expect(isUntitledIntent('I want to do XYZ')).toBe(true);
    expect(isUntitledIntent('Add a low-stock badge')).toBe(false);
  });
});
