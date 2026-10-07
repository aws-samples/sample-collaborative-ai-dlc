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
  LOOP_BACK_RECORDED_EVENT,
  isCodeGenerationStage,
  loopBackApplies,
  loopBackTarget,
  resolveLoopBackOffer,
} from '../stage-loopback.js';

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
const SEGMENT = [codeGeneration, buildAndTest];
const REASON = 'integration tests fail in the payment lane';

describe('the constants the rule is read from', () => {
  it('names the cap, the option and the typed event once', () => {
    expect(LOOP_BACK_LIMIT).toBe(3);
    expect(LOOP_BACK_OPTION).toBe('loop-back');
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
  it('is the stage immediately before this one when it is code generation', () => {
    expect(loopBackTarget({ segmentStages: SEGMENT, currentIndex: 1 })).toEqual({
      index: 0,
      stageId: 'code-generation',
    });
  });

  it('is null when the stage immediately before is not code generation', () => {
    // A deployment stage after build-and-test, or build-and-test after another
    // stage, does not loop back: upstream only sends build-and-test back.
    expect(
      loopBackTarget({
        segmentStages: [codeGeneration, ciPipeline, buildAndTest],
        currentIndex: 2,
      }),
    ).toBeNull();
    expect(loopBackTarget({ segmentStages: SEGMENT, currentIndex: 0 })).toBeNull();
  });

  it('passes over a skipped stage to the one before it', () => {
    expect(
      loopBackTarget({
        segmentStages: [codeGeneration, ciPipeline, buildAndTest],
        currentIndex: 2,
        skippedStageIds: ['ci-pipeline'],
      }),
    ).toEqual({ index: 0, stageId: 'code-generation' });
  });

  it('is null when code generation itself was skipped', () => {
    expect(
      loopBackTarget({
        segmentStages: SEGMENT,
        currentIndex: 1,
        skippedStageIds: ['code-generation'],
      }),
    ).toBeNull();
  });
});

describe('resolveLoopBackOffer', () => {
  const offer = (over = {}) =>
    resolveLoopBackOffer({
      stage: buildAndTest,
      segmentStages: SEGMENT,
      currentIndex: 1,
      recommendation: REASON,
      loopBackCount: 0,
      ...over,
    });

  it('offers the loop-back with the computed target and the remaining budget', () => {
    expect(offer()).toEqual({
      offered: true,
      target: { index: 0, stageId: 'code-generation' },
      spent: 0,
      remaining: 3,
      reason: REASON,
    });
  });

  it('withholds the option at the cap but still reports why, so the gate can say so', () => {
    expect(offer({ loopBackCount: LOOP_BACK_LIMIT })).toEqual({
      offered: false,
      atCap: true,
      target: { index: 0, stageId: 'code-generation' },
      spent: LOOP_BACK_LIMIT,
      reason: REASON,
    });
    expect(offer({ loopBackCount: 2 })).toMatchObject({
      offered: true,
      spent: 2,
      remaining: 1,
    });
  });

  it('reports a recommendation it cannot offer, so the gate does not drop it', () => {
    // Per-unit code generation runs in a parallel section, so build-and-test is
    // the first stage of its segment and has no linear target.
    expect(offer({ segmentStages: [buildAndTest], currentIndex: 0 })).toEqual({
      offered: false,
      unavailable: true,
      reason: REASON,
    });
  });

  it('does not offer without a resolved release policy or capability', () => {
    expect(offer({ stage: { ...buildAndTest, policy: null } })).toEqual({
      offered: false,
    });
    expect(offer({ stage: { ...buildAndTest, policy: { loopBack: null } } })).toEqual({
      offered: false,
    });
  });

  it('does not offer without an agent recommendation', () => {
    expect(offer({ recommendation: null })).toEqual({ offered: false });
    expect(offer({ recommendation: '' })).toEqual({ offered: false });
  });
});
