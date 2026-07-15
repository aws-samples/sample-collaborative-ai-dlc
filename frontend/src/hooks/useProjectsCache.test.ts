import { describe, it, expect } from 'vitest';
import { deriveActivity } from './useProjectsCache';
import type { Intent, IntentStatus } from '@/services/intents';

// Only `status` matters to deriveActivity; keep fixtures minimal.
const intent = (status: IntentStatus): Intent => ({ status }) as Intent;

describe('deriveActivity — dashboard per-project counts', () => {
  it('counts nothing for an empty list', () => {
    expect(deriveActivity([])).toEqual({ inProgress: 0, attention: 0 });
  });

  it('inProgress = RUNNING + WAITING + CREATED + FAILED', () => {
    const intents = [intent('RUNNING'), intent('WAITING'), intent('CREATED'), intent('FAILED')];
    expect(deriveActivity(intents).inProgress).toBe(4);
  });

  it('attention = WAITING + FAILED only', () => {
    const intents = [intent('RUNNING'), intent('WAITING'), intent('CREATED'), intent('FAILED')];
    expect(deriveActivity(intents).attention).toBe(2);
  });

  it('attention is a subset of inProgress (WAITING counts in both)', () => {
    const { inProgress, attention } = deriveActivity([intent('WAITING'), intent('WAITING')]);
    expect(inProgress).toBe(2);
    expect(attention).toBe(2);
  });

  it('excludes terminal-done and abandoned statuses from both counts', () => {
    const intents = [intent('SUCCEEDED'), intent('CANCELLED'), intent('DRAFT')];
    expect(deriveActivity(intents)).toEqual({ inProgress: 0, attention: 0 });
  });

  it('aggregates across a mixed multi-intent project', () => {
    const intents = [
      intent('SUCCEEDED'), // ignored
      intent('RUNNING'), //    inProgress
      intent('WAITING'), //    inProgress + attention
      intent('FAILED'), //     inProgress + attention
      intent('CANCELLED'), //  ignored
    ];
    expect(deriveActivity(intents)).toEqual({ inProgress: 3, attention: 2 });
  });
});
