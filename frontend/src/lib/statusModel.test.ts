import { describe, expect, it } from 'vitest';
import {
  STATUS_REGISTRY,
  ageLabel,
  getStatus,
  latestActivityAt,
  statusLabel,
  type StatusKind,
} from './statusModel';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

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

describe('status labels', () => {
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
