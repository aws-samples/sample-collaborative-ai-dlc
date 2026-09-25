// Build-and-Test loop-back derivation.
//
// Everything asserted here is pure: which stage a loop-back targets, whether the
// offer is on, and the cap. The orchestrator test covers the walk and the row
// resets; this file is the rule.

import { describe, expect, it } from 'vitest';
import {
  LOOP_BACK_CAPABILITY,
  LOOP_BACK_LIMIT,
  LOOP_BACK_OPTION,
  LOOP_BACK_RECOMMENDED_EVENT,
  LOOP_BACK_RECORDED_EVENT,
  isCodeGenerationStage,
  loopBackApplies,
  loopBackRecommendation,
  loopBackTarget,
  resolveLoopBackOffer,
} from '../stage-loopback.js';
import { buildEventRow } from '../v2-process-keys.js';

const codeGeneration = {
  stageId: 'code-generation',
  stageInstanceId: 'si-cg',
  outputArtifacts: [{ artifact: 'code-generation-plan' }, { artifact: 'code-summary' }],
};
const ciPipeline = { stageId: 'ci-pipeline', stageInstanceId: 'si-ci', outputArtifacts: [] };
const buildAndTest = {
  stageId: 'build-and-test',
  stageInstanceId: 'si-bt',
  outputArtifacts: [{ artifact: 'build-test-results' }],
  policy: { loopBack: 'human-offered' },
};
const SEGMENT = [codeGeneration, ciPipeline, buildAndTest];

// Fixtures are built through the SAME row builder the process store persists
// with, so they carry the real shape — `type: 'Event'` plus the name in
// `eventType` — and cannot drift from what `listEvents` returns in production.
let eventSeq = 0;
const persisted = (fields) => {
  eventSeq += 1;
  return buildEventRow({
    executionId: 'exec-1',
    actor: 'agentcore',
    summary: '',
    now: new Date(Date.UTC(2026, 0, 1, 0, 0, eventSeq)).toISOString(),
    eventId: `ev-${eventSeq}`,
    ...fields,
  });
};
const recommended = (attempt = 0, reason = 'integration tests fail in the payment lane') =>
  persisted({
    type: LOOP_BACK_RECOMMENDED_EVENT,
    stageInstanceId: 'si-bt',
    detail: { attempt, reason },
  });
describe('the constants the rule is read from', () => {
  it('names the cap, the option and the two typed events once', () => {
    expect(LOOP_BACK_LIMIT).toBe(3);
    expect(LOOP_BACK_OPTION).toBe('loop-back');
    expect(LOOP_BACK_RECOMMENDED_EVENT).toBe('v2.loopback.recommended');
    expect(LOOP_BACK_RECORDED_EVENT).toBe('v2.loopback.recorded');
    expect(LOOP_BACK_CAPABILITY).toBe('PROTOCOL:build-and-test-loopback');
  });

  it('turns the offer on only for a catalog that proves it has the capability', () => {
    expect(loopBackApplies({ capabilities: { [LOOP_BACK_CAPABILITY]: true } })).toBe(true);
    expect(loopBackApplies({ capabilities: {} })).toBe(false);
    expect(loopBackApplies()).toBe(false);
  });
});

describe('isCodeGenerationStage', () => {
  it('reads the authored code-generation-plan output as the marker', () => {
    expect(isCodeGenerationStage(codeGeneration)).toBe(true);
    expect(isCodeGenerationStage(buildAndTest)).toBe(false);
    expect(isCodeGenerationStage(ciPipeline)).toBe(false);
  });

  it('honours workspaceRequires first, so mapping that key later needs no change', () => {
    expect(isCodeGenerationStage({ stageId: 'x', workspaceRequires: true })).toBe(true);
  });

  it('accepts the bare-string output shape the plan also permits', () => {
    expect(isCodeGenerationStage({ outputArtifacts: ['code-generation-plan'] })).toBe(true);
  });
});

describe('loopBackTarget', () => {
  it('finds the nearest preceding code-generation stage in the segment', () => {
    expect(loopBackTarget({ segmentStages: SEGMENT, currentIndex: 2 })).toEqual({
      index: 0,
      stageId: 'code-generation',
    });
  });

  it('is null when no code-generation stage precedes this one', () => {
    expect(
      loopBackTarget({ segmentStages: [ciPipeline, buildAndTest], currentIndex: 1 }),
    ).toBeNull();
    expect(loopBackTarget({ segmentStages: SEGMENT, currentIndex: 0 })).toBeNull();
  });

  it('skips a target the intent deselected — a SKIPPED stage is not a jump target', () => {
    expect(
      loopBackTarget({
        segmentStages: SEGMENT,
        currentIndex: 2,
        skippedStageIds: ['code-generation'],
      }),
    ).toBeNull();
  });

  it('takes the NEAREST of several candidates', () => {
    const segment = [
      codeGeneration,
      { ...codeGeneration, stageId: 'code-generation-2' },
      buildAndTest,
    ];
    expect(loopBackTarget({ segmentStages: segment, currentIndex: 2 })).toEqual({
      index: 1,
      stageId: 'code-generation-2',
    });
  });
});

describe('loopBackRecommendation', () => {
  it('reads the agent recommendation for THIS attempt of THIS stage', () => {
    expect(
      loopBackRecommendation({ events: [recommended(0)], stageInstanceId: 'si-bt', attempt: 0 }),
    ).toEqual({ reason: 'integration tests fail in the payment lane' });
  });

  it('is invisible after a rewind bumped the attempt', () => {
    expect(
      loopBackRecommendation({ events: [recommended(0)], stageInstanceId: 'si-bt', attempt: 1 }),
    ).toBeNull();
  });

  it('ignores a recommendation recorded against another stage', () => {
    expect(
      loopBackRecommendation({ events: [recommended(0)], stageInstanceId: 'si-other', attempt: 0 }),
    ).toBeNull();
  });

  it('takes the latest when the agent recorded several in one attempt', () => {
    expect(
      loopBackRecommendation({
        events: [recommended(0, 'first'), recommended(0, 'second')],
        stageInstanceId: 'si-bt',
        attempt: 0,
      }),
    ).toEqual({ reason: 'second' });
  });
});

describe('resolveLoopBackOffer', () => {
  const offer = (over = {}) =>
    resolveLoopBackOffer({
      stage: buildAndTest,
      segmentStages: SEGMENT,
      currentIndex: 2,
      events: [recommended(0)],
      attempt: 0,
      loopBackCount: 0,
      ...over,
    });

  it('offers the loop-back with the computed target and the remaining budget', () => {
    expect(offer()).toEqual({
      offered: true,
      atCap: false,
      target: { index: 0, stageId: 'code-generation' },
      spent: 0,
      remaining: 3,
      reason: 'integration tests fail in the payment lane',
    });
  });

  it('withholds the option at the cap but still reports WHY, so the gate can say so', () => {
    const atCap = offer({ loopBackCount: LOOP_BACK_LIMIT });
    expect(atCap.offered).toBe(false);
    expect(atCap.atCap).toBe(true);
    expect(atCap.spent).toBe(LOOP_BACK_LIMIT);
    expect(atCap.target).toEqual({ index: 0, stageId: 'code-generation' });
    expect(atCap.reason).toBe('integration tests fail in the payment lane');
  });

  // The execution counter is incremented by each successful target reset, so
  // the offer stays bounded even if the timeline event is missing.
  it('enforces the cap at exactly three durable target resets across attempts', () => {
    let loopBackCount = 0;
    const offers = [];
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const decision = offer({
        events: [recommended(attempt, `attempt ${attempt} failed`)],
        attempt,
        loopBackCount,
      });
      offers.push(decision.offered);
      if (decision.offered) loopBackCount += 1;
    }
    expect(offers).toEqual([true, true, true, false, false]);
    expect(loopBackCount).toBe(LOOP_BACK_LIMIT);
    expect(offer({ events: [recommended(4)], attempt: 4, loopBackCount })).toMatchObject({
      atCap: true,
      spent: 3,
    });
  });

  it('uses the target stage counter when recorded timeline events are absent', () => {
    expect(offer({ events: [recommended(0)], loopBackCount: 2 })).toMatchObject({
      offered: true,
      spent: 2,
      remaining: 1,
    });
    expect(offer({ events: [recommended(0)], loopBackCount: 3 })).toMatchObject({
      offered: false,
      atCap: true,
      spent: 3,
    });
  });

  it('withholds the option when the target counter is unavailable', () => {
    expect(offer({ loopBackCount: null })).toMatchObject({ offered: false, atCap: false });
  });

  it('does not offer without a resolved release policy', () => {
    expect(offer({ stage: { ...buildAndTest, policy: null } })).toEqual({
      offered: false,
      atCap: false,
    });
  });

  it('does not offer when the release has no construction loop-back capability', () => {
    expect(offer({ stage: { ...buildAndTest, policy: { loopBack: null } } })).toEqual({
      offered: false,
      atCap: false,
    });
  });

  it('does not offer without an agent recommendation for this attempt', () => {
    expect(offer({ events: [] })).toEqual({ offered: false, atCap: false });
    expect(offer({ events: [recommended(1)] })).toEqual({ offered: false, atCap: false });
  });

  it('does not offer when the segment has no code-generation stage to go back to', () => {
    expect(offer({ segmentStages: [buildAndTest], currentIndex: 0 })).toEqual({
      offered: false,
      atCap: false,
    });
  });
});
