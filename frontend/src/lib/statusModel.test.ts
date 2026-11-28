import { describe, expect, it } from 'vitest';
import {
  STATUS_REGISTRY,
  ageLabel,
  deriveIntentStatus,
  deriveSensorStatus,
  getStatus,
  intentStatusLabel,
  isTerminalIntentStatus,
  latestActivityAt,
  statusFromDetail,
  statusLabel,
  type StatusKind,
} from './statusModel';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();
const running = () => ({
  status: 'RUNNING' as const,
  updatedAt: daysAgo(3),
  createdAt: daysAgo(4),
});

describe('STATUS_REGISTRY', () => {
  const kinds = Object.keys(STATUS_REGISTRY) as StatusKind[];

  it.each(kinds)('gives every %s key a human label and a help sentence', (kind) => {
    for (const [key, entry] of Object.entries(STATUS_REGISTRY[kind])) {
      expect(entry.label, key).toMatch(/^[A-Z][^_]*$/);
      expect(entry.label, key).not.toBe(entry.label.toUpperCase());
      expect(entry.help, key).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('uses one word and tone per outcome across intents and stages', () => {
    const { intent, stage } = STATUS_REGISTRY;
    expect(intent.SUCCEEDED).toMatchObject({ label: stage.SUCCEEDED.label, tone: 'success' });
    expect(intent.FAILED).toMatchObject({ label: stage.FAILED.label, tone: 'danger' });
    expect(intent.WAITING).toMatchObject({ label: stage.WAITING_FOR_HUMAN.label, tone: 'waiting' });
  });

  it('marks only genuinely active states as live', () => {
    const live = kinds.flatMap((kind) =>
      Object.entries(STATUS_REGISTRY[kind])
        .filter(([, entry]) => entry.live)
        .map(([key]) => `${kind}:${key}`),
    );
    expect(live).toEqual(expect.arrayContaining(['intent:RUNNING', 'stage:RUNNING']));
    expect(live).not.toContain('intent:WAITING');
    expect(live).not.toContain('intent:CREATED');
  });

  it('falls back to a humanized neutral entry for an unknown key', () => {
    expect(getStatus('intent', 'SOMETHING_NEW')).toMatchObject({
      label: 'Something new',
      tone: 'neutral',
    });
    expect(getStatus('intent', 'SOMETHING_NEW').live).toBeFalsy();
  });
});

describe('deriveSensorStatus', () => {
  it.each([
    [{ result: 'PASS', held: false }, 'passed', 'success'],
    [{ result: 'FAIL', held: false }, 'advisory', 'neutral'],
    [{ result: 'INCONCLUSIVE', held: false }, 'inconclusive', 'neutral'],
    [{ result: 'BLOCKED', held: false }, 'not_run', 'neutral'],
    [{ result: 'FAIL', held: true }, 'blocking', 'danger'],
    [{ result: 'BLOCKED', held: true }, 'blocking', 'danger'],
  ] as const)('%o → %s (%s): only a held verdict is red', (run, key, tone) => {
    expect(deriveSensorStatus({ ...run, severity: 'advisory' })).toBe(key);
    expect(getStatus('sensor', key).tone).toBe(tone);
  });
});

describe('deriveIntentStatus', () => {
  it('stalls a run after 30 minutes without activity', () => {
    expect(deriveIntentStatus(running(), { now: NOW, lastActivityAt: minutesAgo(29) })).toEqual({
      key: 'RUNNING',
      stalled: false,
    });
    expect(deriveIntentStatus(running(), { now: NOW, lastActivityAt: minutesAgo(31) })).toEqual({
      key: 'RUNNING',
      stalled: true,
      since: minutesAgo(31),
    });
  });

  it('stalls a CREATED intent nobody claimed', () => {
    const created = daysAgo(2);
    expect(
      deriveIntentStatus(
        { status: 'CREATED', updatedAt: created, createdAt: created },
        { now: NOW },
      ),
    ).toEqual({ key: 'CREATED', stalled: true, since: created });
  });

  it('falls back to updatedAt when no activity timestamp is given', () => {
    expect(
      deriveIntentStatus(
        { status: 'RUNNING', updatedAt: minutesAgo(5), createdAt: daysAgo(1) },
        { now: NOW },
      ).stalled,
    ).toBe(false);
    expect(
      deriveIntentStatus(
        { status: 'RUNNING', updatedAt: daysAgo(123), createdAt: daysAgo(124) },
        { now: NOW },
      ),
    ).toMatchObject({ stalled: true, since: daysAgo(123) });
  });

  it('never stalls without a parseable timestamp', () => {
    expect(
      deriveIntentStatus(
        { status: 'RUNNING', updatedAt: null, createdAt: null },
        { now: NOW, lastActivityAt: 'not a date' },
      ).stalled,
    ).toBe(false);
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'DRAFT', 'WAITING'] as const)(
    'never stalls a %s intent',
    (status) => {
      expect(
        deriveIntentStatus(
          { status, updatedAt: daysAgo(200), createdAt: daysAgo(200) },
          { now: NOW, lastActivityAt: daysAgo(200) },
        ).stalled,
      ).toBe(false);
    },
  );
});

describe('waiting since: the oldest open decision, on every surface', () => {
  const waiting = { status: 'WAITING', updatedAt: daysAgo(1), createdAt: daysAgo(140) } as const;

  it('uses the oldest pending gate, even when another is current, ignoring answered ones', () => {
    const result = deriveIntentStatus(
      { ...waiting, pendingHumanTaskId: 'feas' },
      {
        now: NOW,
        gates: [
          { humanTaskId: 'old', status: 'answered', createdAt: daysAgo(139), updatedAt: null },
          { humanTaskId: 'scope', status: 'pending', createdAt: null, updatedAt: daysAgo(137) },
          { humanTaskId: 'feas', status: 'pending', createdAt: daysAgo(109), updatedAt: null },
        ],
      },
    );
    expect(result).toEqual({ key: 'WAITING', stalled: false, since: daysAgo(137) });
  });

  it('counts stages parked for a human as open decisions', () => {
    const result = deriveIntentStatus(waiting, {
      now: NOW,
      gates: [{ humanTaskId: 'a', status: 'pending', createdAt: daysAgo(12), updatedAt: null }],
      stages: [
        { state: 'WAITING_FOR_HUMAN', parkedAt: daysAgo(20), updatedAt: daysAgo(2) },
        { state: 'SUCCEEDED', parkedAt: null, updatedAt: daysAgo(30) },
      ],
    });
    expect(result.since).toBe(daysAgo(20));
  });

  it('falls back to updatedAt once the gates are known, and has no age before (R3-5)', () => {
    expect(deriveIntentStatus(waiting, { now: NOW, gates: [] }).since).toBe(daysAgo(1));
    // Unknown: updatedAt is the newest gate, not the oldest — no age rather
    // than one the header will contradict.
    expect(deriveIntentStatus(waiting, { now: NOW })).toEqual({ key: 'WAITING', stalled: false });
  });

  it('derives the same status from a cached detail as the intent page does', () => {
    const gate = { humanTaskId: 'scope', status: 'pending', createdAt: daysAgo(137) } as const;
    expect(
      statusFromDetail({ intent: waiting, gates: [{ ...gate, updatedAt: null }] }, { now: NOW }),
    ).toEqual({ key: 'WAITING', stalled: false, since: daysAgo(137) });
  });

  it('uses stage and event timestamps as activity when deriving from a detail', () => {
    const detail = {
      intent: running(),
      stages: [{ state: 'RUNNING' as const, startedAt: daysAgo(1), updatedAt: null }],
      events: [{ timestamp: minutesAgo(2) }],
    };
    expect(statusFromDetail(detail, { now: NOW }).stalled).toBe(false);
    expect(statusFromDetail({ intent: running() }, { now: NOW }).stalled).toBe(true);
  });
});

describe('status labels', () => {
  it.each([
    [{ key: 'RUNNING', stalled: true, since: daysAgo(123) }, 'Stalled · no activity for 4 months'],
    [{ key: 'CREATED', stalled: true }, 'Stalled'],
    [{ key: 'WAITING', stalled: false, since: daysAgo(108) }, 'Waiting for input · 108 days'],
    [{ key: 'SUCCEEDED', stalled: false }, 'Completed'],
    [{ key: 'FAILED', stalled: false, since: daysAgo(59) }, 'Failed 59 days ago'],
    [{ key: 'SUCCEEDED', stalled: false, since: minutesAgo(5) }, 'Completed 5 min ago'],
  ] as const)('intent %o → %s', (derived, expected) => {
    expect(intentStatusLabel(derived, { now: NOW })).toBe(expected);
  });

  it.each([
    [{ key: 'WAITING', stalled: false, since: daysAgo(108) }, 'Waiting · 108 d'],
    [{ key: 'WAITING', stalled: false, since: minutesAgo(180) }, 'Waiting · 3 h'],
    [{ key: 'RUNNING', stalled: true, since: daysAgo(123) }, 'Stalled · 4 mo'],
    [{ key: 'RUNNING', stalled: true, since: daysAgo(400) }, 'Stalled · 1 y'],
    [{ key: 'RUNNING', stalled: false }, 'Running'],
    [{ key: 'FAILED', stalled: false, since: daysAgo(59) }, 'Failed 59 d ago'],
  ] as const)('compact intent %o → %s', (derived, expected) => {
    expect(intentStatusLabel(derived, { now: NOW, compact: true })).toBe(expected);
  });

  it.each([
    ['stage', 'FAILED', 'Failed 2 days ago'],
    ['stage', 'SUCCEEDED', 'Completed 2 days ago'],
    ['gate', 'answered', 'Answered 2 days ago'],
    ['gate', 'superseded', 'Withdrawn 2 days ago'],
    ['unit', 'MERGED', 'Integrated 2 days ago'],
    ['stage', 'WAITING_FOR_HUMAN', 'Waiting for input · 2 days'],
    ['gate', 'pending', 'Waiting for answer · 2 days'],
    ['gate', 'resume_required', 'Needs resume · 2 days'],
    ['unit', 'RUNNING', 'Building · 2 days'],
    ['connection', 'connected', 'Live updates · 2 days'],
  ] as const)('%s %s: ended states read "ago", open ones a duration → %s', (kind, status, out) => {
    expect(statusLabel(kind, status, { since: daysAgo(2), now: NOW })).toBe(out);
  });

  it.each([
    ['FAILED', true],
    ['CANCELLED', true],
    ['RUNNING', false],
    [undefined, false],
  ] as const)('isTerminalIntentStatus(%s) → %s', (status, expected) => {
    expect(isTerminalIntentStatus(status)).toBe(expected);
  });
});

describe('latestActivityAt', () => {
  it('returns the most recent valid timestamp', () => {
    expect(latestActivityAt([daysAgo(3), null, 'nope', minutesAgo(2), undefined, daysAgo(1)])).toBe(
      minutesAgo(2),
    );
    expect(latestActivityAt([null, undefined])).toBeUndefined();
  });
});

describe('ageLabel', () => {
  it.each([
    [0.5, 'under 1 min'],
    [2, '2 min'],
    [59, '59 min'],
    [180, '3 h'],
    [60 * 24, '1 day'],
    [60 * 24 * 108, '108 days'],
  ])('%s min → %s', (minutes, expected) => {
    expect(ageLabel(minutesAgo(minutes), NOW)).toBe(expected);
  });

  it('switches to months and years in coarse mode', () => {
    expect(ageLabel(daysAgo(123), NOW, { coarse: true })).toBe('4 months');
    expect(ageLabel(daysAgo(40), NOW, { coarse: true })).toBe('40 days');
    expect(ageLabel(daysAgo(400), NOW, { coarse: true })).toBe('1 year');
  });

  it('accepts a Date clock and returns empty for unusable input', () => {
    expect(ageLabel(minutesAgo(2), new Date(NOW))).toBe('2 min');
    expect(ageLabel(undefined, NOW)).toBe('');
    expect(ageLabel('garbage', NOW)).toBe('');
    expect(ageLabel(minutesAgo(-10), NOW)).toBe('under 1 min');
  });
});
