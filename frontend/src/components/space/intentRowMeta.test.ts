import { describe, expect, it } from 'vitest';
import type { Intent } from '@/services/intents';
import { describePendingGates, intentRowMeta, intentRowMetaText } from './intentRowMeta';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

function intent(status: Intent['status'], extra: Partial<Intent> = {}): Intent {
  return {
    id: 'i1',
    title: 'Intent',
    status,
    createdAt: daysAgo(10),
    updatedAt: daysAgo(2),
    completedAt: null,
    currentStage: null,
    pendingHumanTaskId: null,
    failureReason: null,
    ...extra,
  } as Intent;
}

describe('intentRowMeta', () => {
  it('names the stage a run failed at from the failure reason, with the failure time', () => {
    const meta = intentRowMeta(
      intent('FAILED', {
        currentStage: 'state-init',
        failureReason: 'stage_failed: deployment-pipeline: cli_nonzero_exit: exit 1',
      }),
      { now: NOW },
    );
    expect(meta.parts).toEqual(['Failed at Deployment Pipeline']);
    expect(meta.time).toEqual({ value: daysAgo(2), prefix: '' });
  });

  it('falls back to the current stage when the reason does not name one, and to "Failed" without any', () => {
    expect(
      intentRowMeta(intent('FAILED', { currentStage: 'reverse-engineering' }), { now: NOW }).parts,
    ).toEqual(['Failed at Reverse Engineering']);
    const bare = intentRowMeta(intent('FAILED'), { now: NOW });
    expect(bare.parts).toEqual([]);
    expect(bare.time).toEqual({ value: daysAgo(2), prefix: 'Failed' });
  });

  it('says what waits on a pending question before the stage: the gate kinds when known, the stage alone otherwise (R3-5)', () => {
    const waiting = intent('WAITING', {
      currentStage: 'requirements-analysis',
      pendingHumanTaskId: 'g1',
    });
    const unknown = intentRowMeta(waiting, { now: NOW });
    expect(unknown).toEqual({ parts: ['Requirements Analysis'], time: null });
    // Known but the pending task is not listed yet: one decision, no guess at its kind.
    expect(intentRowMeta(waiting, { now: NOW, gates: [] }).parts).toEqual([
      '1 decision',
      'Requirements Analysis',
    ]);
    const known = intentRowMeta(waiting, {
      now: NOW,
      gates: [
        { status: 'pending', kind: 'question' },
        { status: 'pending', kind: 'question' },
        { status: 'answered', kind: 'approval' },
      ],
    });
    expect(known.parts).toEqual(['2 questions', 'Requirements Analysis']);
    expect(
      describePendingGates([
        { status: 'pending', kind: 'question' },
        { status: 'pending', kind: 'validation' },
      ]),
    ).toBe('1 question · 1 approval');
  });

  it('says a saved answer needs a resume, with the stage and how long it has waited', () => {
    const meta = intentRowMeta(
      intent('WAITING', {
        currentStage: 'feasibility-assessment',
        pendingHumanTaskId: 'g1',
        updatedAt: daysAgo(10),
        resumeRequired: { humanTaskId: 'g1', callbackId: 'cb', answeredAt: null },
      }),
      { now: NOW },
    );
    expect(meta).toEqual({
      parts: ['Resume needed', 'Feasibility Assessment', 'waiting 10 days'],
      time: null,
    });
  });

  it('labels a stuck run as stalled at its stage, with the last activity as the time', () => {
    const meta = intentRowMeta(
      intent('RUNNING', {
        currentStage: 'intent-capture',
        createdAt: daysAgo(130),
        updatedAt: daysAgo(120),
      }),
      { now: NOW },
    );
    expect(meta).toEqual({
      parts: ['Stalled at Intent Capture'],
      time: { value: daysAgo(120), prefix: 'Last activity' },
    });
    expect(
      intentRowMeta(intent('RUNNING', { createdAt: daysAgo(130), updatedAt: daysAgo(120) }), {
        now: NOW,
      }).parts,
    ).toEqual(['Stalled']);
  });

  it('puts the wait in the meta line once its start is known, never guessed from updatedAt', () => {
    const waiting = intent('WAITING', {
      currentStage: 'feasibility-assessment',
      pendingHumanTaskId: 'g1',
      updatedAt: daysAgo(3),
    });
    expect(intentRowMeta(waiting, { now: NOW }).parts).toEqual(['Feasibility Assessment']);
    expect(intentRowMeta(waiting, { now: NOW, since: daysAgo(108) }).parts).toEqual([
      'Feasibility Assessment',
      'waiting 108 days',
    ]);
  });

  it('keeps the stage and the update time on a live run', () => {
    const meta = intentRowMeta(
      intent('RUNNING', { currentStage: 'reverse-engineering', updatedAt: daysAgo(0.001) }),
      { now: NOW },
    );
    expect(meta.parts).toEqual(['Reverse Engineering']);
    expect(meta.time?.prefix).toBe('Updated');
  });

  it('uses the completion time with the terminal verb for finished runs', () => {
    expect(intentRowMeta(intent('SUCCEEDED', { completedAt: daysAgo(1) }), { now: NOW })).toEqual({
      parts: [],
      time: { value: daysAgo(1), prefix: 'Completed' },
    });
    expect(intentRowMeta(intent('CANCELLED'), { now: NOW }).time).toEqual({
      value: daysAgo(2),
      prefix: 'Cancelled',
    });
  });

  it('renders the same tokens as text for the inbox, with the time as an age', () => {
    expect(
      intentRowMetaText(
        intent('FAILED', { currentStage: 'deployment-pipeline', updatedAt: daysAgo(56) }),
        { now: NOW },
      ),
    ).toEqual(['Failed at Deployment Pipeline', '56 days ago']);
    expect(intentRowMetaText(intent('FAILED', { updatedAt: daysAgo(56) }), { now: NOW })).toEqual([
      'Failed 56 days ago',
    ]);
    expect(
      intentRowMetaText(
        intent('WAITING', { currentStage: 'feasibility-assessment', pendingHumanTaskId: 'g1' }),
        { now: NOW },
      ),
    ).toEqual(['Feasibility Assessment']);
    expect(
      intentRowMetaText(
        intent('RUNNING', {
          currentStage: 'intent-capture',
          createdAt: daysAgo(130),
          updatedAt: daysAgo(120),
        }),
        { now: NOW },
      ),
    ).toEqual(['Stalled at Intent Capture', 'Last activity 120 days ago']);
  });
});
