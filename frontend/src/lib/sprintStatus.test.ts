import { describe, expect, it } from 'vitest';
import type { Sprint } from '@/services/sprints';
import type { IntentStatus } from '@/services/intents';
import {
  effectiveIntentStatus,
  effectiveSprintStatus,
  intentAttention,
  isActiveStatus,
  needsAttention,
  type EffectiveSprintStatus,
} from './sprintStatus';

// Regression pins: these outputs feed the sidebar, Space list and v1 pages.
// The status registry (statusModel.ts) must not change them.

describe('effectiveIntentStatus', () => {
  const cases: [IntentStatus, EffectiveSprintStatus][] = [
    ['DRAFT', 'idle'],
    ['CREATED', 'idle'],
    ['RUNNING', 'running'],
    ['WAITING', 'waiting'],
    ['SUCCEEDED', 'passed'],
    ['FAILED', 'failed'],
    ['CANCELLED', 'idle'],
  ];
  it.each(cases)('%s → %s', (status, expected) => {
    expect(effectiveIntentStatus({ status })).toBe(expected);
  });

  it('treats a missing intent as idle', () => {
    expect(effectiveIntentStatus(null)).toBe('idle');
  });
});

describe('intentAttention', () => {
  it('flags FAILED regardless of other fields', () => {
    expect(intentAttention({ status: 'FAILED', pendingHumanTaskId: 'h1' })).toBe('failed');
  });

  it('asks for resume before input when a WAITING run needs resuming', () => {
    expect(
      intentAttention({ status: 'WAITING', pendingHumanTaskId: 'h1', resumeRequired: true }),
    ).toBe('resume');
    expect(
      intentAttention({
        status: 'WAITING',
        resumeRequired: { humanTaskId: 'h1', callbackId: 'c1', answeredAt: null },
      }),
    ).toBe('resume');
  });

  it('asks for input only when a WAITING run has a pending gate', () => {
    expect(intentAttention({ status: 'WAITING', pendingHumanTaskId: 'h1' })).toBe('input');
    expect(intentAttention({ status: 'WAITING', pendingHumanTaskId: null })).toBeNull();
    expect(intentAttention({ status: 'WAITING' })).toBeNull();
  });

  it.each<IntentStatus>(['DRAFT', 'CREATED', 'RUNNING', 'SUCCEEDED', 'CANCELLED'])(
    'needs no attention for %s',
    (status) => {
      expect(
        intentAttention({ status, pendingHumanTaskId: 'h1', resumeRequired: true }),
      ).toBeNull();
    },
  );
});

describe('isActiveStatus', () => {
  it.each<[EffectiveSprintStatus, boolean]>([
    ['running', true],
    ['waiting', true],
    ['passed', false],
    ['completed', false],
    ['failed', false],
    ['idle', false],
  ])('%s → %s', (status, expected) => {
    expect(isActiveStatus(status)).toBe(expected);
  });
});

describe('effectiveSprintStatus', () => {
  const sprint = (fields: Partial<Sprint>) => fields as Sprint;

  it('reports a COMPLETED phase as passed even after a failed agent run', () => {
    expect(
      effectiveSprintStatus(sprint({ phase: 'COMPLETED', currentAgentStatus: 'failed' })),
    ).toBe('passed');
  });

  it('passes through known agent statuses and defaults to idle', () => {
    expect(effectiveSprintStatus(sprint({ currentAgentStatus: 'running' }))).toBe('running');
    expect(effectiveSprintStatus(sprint({ currentAgentStatus: 'failed' }))).toBe('failed');
    expect(effectiveSprintStatus(sprint({}))).toBe('idle');
    expect(effectiveSprintStatus(null)).toBe('idle');
  });
});

describe('needsAttention', () => {
  const NOW = Date.parse('2026-11-22T12:00:00Z');
  const ago = (min: number) => new Date(NOW - min * 60_000).toISOString();
  const base = { updatedAt: ago(1), createdAt: ago(10) };

  it('counts what the Spaces inbox counts: answers, resumes, failures and stalled runs', () => {
    expect(needsAttention({ ...base, status: 'WAITING', pendingHumanTaskId: 'h' }, NOW)).toBe(true);
    expect(needsAttention({ ...base, status: 'WAITING', resumeRequired: true }, NOW)).toBe(true);
    expect(needsAttention({ ...base, status: 'FAILED' }, NOW)).toBe(true);
    expect(needsAttention({ status: 'RUNNING', updatedAt: ago(31), createdAt: ago(60) }, NOW)).toBe(
      true,
    );
  });

  it('leaves healthy, idle and finished intents out', () => {
    expect(needsAttention({ ...base, status: 'RUNNING' }, NOW)).toBe(false);
    expect(needsAttention({ ...base, status: 'WAITING' }, NOW)).toBe(false);
    expect(needsAttention({ ...base, status: 'SUCCEEDED' }, NOW)).toBe(false);
    expect(needsAttention({ ...base, status: 'CANCELLED' }, NOW)).toBe(false);
    expect(needsAttention({ ...base, status: 'DRAFT' }, NOW)).toBe(false);
  });
});
