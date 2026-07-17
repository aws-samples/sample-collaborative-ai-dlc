import { describe, expect, it } from 'vitest';
import { deriveLaneWaits } from './intentRecovery';
import type { IntentGate, IntentStage } from '@/services/intents';

const stage = (over: Partial<IntentStage> = {}): IntentStage => ({
  stageInstanceId: 'si-auth',
  stageId: 'functional-design',
  unitSlug: 'auth',
  sectionIndex: 1,
  phase: 'construction',
  state: 'WAITING_FOR_HUMAN',
  attempt: 0,
  cli: 'claude',
  runtimeError: null,
  startedAt: '2026-01-01T00:00:00Z',
  completedAt: null,
  updatedAt: null,
  parkedAt: '2026-01-01T00:01:00Z',
  pendingHumanTaskId: 'q-auth',
  ...over,
});

const gate = (over: Partial<IntentGate> = {}): IntentGate => ({
  humanTaskId: 'q-auth',
  stageInstanceId: 'si-auth',
  unitSlug: 'auth',
  sectionIndex: 1,
  kind: 'question',
  status: 'pending',
  prompt: 'Choose the persistence model.',
  options: null,
  questions: null,
  answer: null,
  answeredBy: null,
  answeredAt: null,
  createdAt: '2026-01-01T00:01:00Z',
  ...over,
});

describe('deriveLaneWaits', () => {
  it('recognizes a pending gate only when it belongs to the exact lane stage', () => {
    expect(deriveLaneWaits([stage()], [gate()])['s1:auth']).toMatchObject({
      kind: 'input',
      humanTaskId: 'q-auth',
    });
  });

  it('marks answered, missing, and sibling-owned gates as recovery', () => {
    expect(deriveLaneWaits([stage()], [gate({ status: 'answered' })])['s1:auth'].kind).toBe(
      'recovery',
    );
    expect(
      deriveLaneWaits([stage()], [gate({ stageInstanceId: 'si-billing', unitSlug: 'billing' })])[
        's1:auth'
      ].kind,
    ).toBe('recovery');
    expect(deriveLaneWaits([stage()], [])['s1:auth'].kind).toBe('recovery');
  });
});
