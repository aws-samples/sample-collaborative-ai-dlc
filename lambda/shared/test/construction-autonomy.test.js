// Construction Autonomy Mode's pure rules: the anchor that always keeps its
// human gate, the waiver predicate, and the escalation offer. Table-driven,
// because every clause of the predicate is a halt-and-ask guarantee and a
// regression in any one of them silently removes a human from the loop.

import { describe, expect, it } from 'vitest';
import {
  AUTONOMOUS_GATE_INPUT,
  AUTONOMY_MODE_SET_EVENT,
  CONSTRUCTION_AUTONOMY_CAPABILITY,
  GATE_AUTO_APPROVED_EVENT,
  GRANT_AUTONOMY_OPTION,
  autonomousGateApplies,
  autonomousLoopBackInput,
  constructionAutonomyApplies,
  firstConstructionStageId,
  grantAutonomyOffered,
} from '../construction-autonomy.js';

const NATIVE = Object.freeze({ constructionAutonomy: 'native' });

const stage = (stageId, over = {}) =>
  Object.freeze({ stageId, phase: 'construction', policy: NATIVE, ...over });

const PLAN = Object.freeze([
  Object.freeze({ stageId: 'requirements', phase: 'inception', policy: NATIVE }),
  stage('functional-design'),
  stage('code-generation', { policy: { ...NATIVE, planApproval: 'required' } }),
  stage('build-and-test'),
  stage('ci-pipeline'),
]);

// A unit-lane scope: code generation runs per unit inside a parallel section,
// whose own skeleton gate and lane ladder are the human stop there. The first
// SEQUENTIAL construction gate is build-and-test.
const LANE_PLAN = Object.freeze([
  Object.freeze({ stageId: 'requirements', phase: 'inception', policy: NATIVE }),
  stage('code-generation', { parallelSection: 0 }),
  stage('build-and-test', { parallelSection: null }),
  stage('ci-pipeline'),
]);

describe('unit-lane scopes', () => {
  it('offers grant-autonomy at the first sequential construction gate', () => {
    expect(grantAutonomyOffered({ mode: null, stage: LANE_PLAN[2], stages: LANE_PLAN })).toBe(true);
  });

  it('never lets a create-time grant waive the first sequential construction gate', () => {
    const base = { mode: 'autonomous', stages: LANE_PLAN };
    expect(autonomousGateApplies({ ...base, stage: LANE_PLAN[2] })).toBe(false);
    expect(autonomousGateApplies({ ...base, stage: LANE_PLAN[3] })).toBe(true);
  });
});

describe('constructionAutonomyApplies', () => {
  it.each([
    { capabilities: { [CONSTRUCTION_AUTONOMY_CAPABILITY]: true }, expected: true },
    { capabilities: {}, expected: false },
    { capabilities: { [CONSTRUCTION_AUTONOMY_CAPABILITY]: false }, expected: false },
    { capabilities: { 'PROTOCOL:build-and-test-loopback': true }, expected: false },
  ])('$capabilities → $expected', ({ capabilities, expected }) => {
    expect(constructionAutonomyApplies({ capabilities })).toBe(expected);
  });

  it('is inert with no argument at all', () => {
    expect(constructionAutonomyApplies()).toBe(false);
  });
});

describe('firstConstructionStageId', () => {
  it('skips non-construction phases', () => {
    expect(firstConstructionStageId({ stages: PLAN })).toBe('functional-design');
  });

  it('moves the anchor when the first construction stage is skipped', () => {
    expect(firstConstructionStageId({ stages: PLAN, skippedStageIds: ['functional-design'] })).toBe(
      'code-generation',
    );
  });

  it('anchors on the first construction stage with a sequential gate', () => {
    expect(firstConstructionStageId({ stages: LANE_PLAN })).toBe('build-and-test');
  });

  it('is null for a plan with no construction stage', () => {
    expect(firstConstructionStageId({ stages: [PLAN[0]] })).toBeNull();
    expect(firstConstructionStageId()).toBeNull();
  });
});

describe('autonomousGateApplies', () => {
  const base = { mode: 'autonomous', stages: PLAN, skippedStageIds: [], fanoutGateNeeded: false };

  it.each([
    {
      name: 'waives a later construction gate',
      input: { ...base, stage: stage('build-and-test') },
      expected: true,
    },
    {
      name: 'never waives the first non-skipped construction stage',
      input: { ...base, stage: stage('functional-design') },
      expected: false,
    },
    {
      name: 'waives the former anchor once it is skipped',
      input: {
        ...base,
        stage: stage('code-generation', { policy: NATIVE }),
        skippedStageIds: ['functional-design'],
      },
      expected: false,
    },
    {
      name: 'never waives a Plan Approval stage',
      input: { ...base, stage: PLAN[2] },
      expected: false,
    },
    {
      name: 'never waives a gate carrying a fan-out approval',
      input: { ...base, stage: stage('build-and-test'), fanoutGateNeeded: true },
      expected: false,
    },
    {
      name: 'never waives a non-construction stage',
      input: { ...base, stage: stage('operate', { phase: 'operation' }) },
      expected: false,
    },
    {
      name: 'gated waives nothing',
      input: { ...base, mode: 'gated', stage: stage('build-and-test') },
      expected: false,
    },
    {
      name: 'an absent grant waives nothing',
      input: { ...base, mode: null, stage: stage('build-and-test') },
      expected: false,
    },
    {
      name: 'only the exact string autonomous is truthy',
      input: { ...base, mode: 'Autonomous', stage: stage('build-and-test') },
      expected: false,
    },
    {
      name: 'an unpinned stage (no resolved policy) waives nothing',
      input: { ...base, stage: stage('build-and-test', { policy: null }) },
      expected: false,
    },
    {
      name: 'a release without the protocol waives nothing',
      input: {
        ...base,
        stage: stage('build-and-test', { policy: { constructionAutonomy: null } }),
      },
      expected: false,
    },
    {
      name: 'a plan with no construction stage waives nothing',
      input: { ...base, stage: stage('build-and-test'), stages: [] },
      expected: false,
    },
  ])('$name', ({ input, expected }) => {
    expect(autonomousGateApplies(input)).toBe(expected);
  });

  it('is inert with no argument at all', () => {
    expect(autonomousGateApplies()).toBe(false);
  });
});

describe('grantAutonomyOffered', () => {
  it.each([
    {
      name: 'offered at the anchor while the run is gated',
      input: { mode: 'gated', stage: stage('functional-design'), stages: PLAN },
      expected: true,
    },
    {
      name: 'offered at the anchor when no grant is recorded yet',
      input: { mode: null, stage: stage('functional-design'), stages: PLAN },
      expected: true,
    },
    {
      name: 'never offered once the grant is already autonomous',
      input: { mode: 'autonomous', stage: stage('functional-design'), stages: PLAN },
      expected: false,
    },
    {
      name: 'never offered at a later construction gate',
      input: { mode: 'gated', stage: stage('build-and-test'), stages: PLAN },
      expected: false,
    },
    {
      name: 'never offered outside construction',
      input: { mode: 'gated', stage: stage('requirements', { phase: 'inception' }), stages: PLAN },
      expected: false,
    },
    {
      name: 'never offered without the protocol',
      input: {
        mode: 'gated',
        stage: stage('functional-design', { policy: null }),
        stages: PLAN,
      },
      expected: false,
    },
  ])('$name', ({ input, expected }) => {
    expect(grantAutonomyOffered(input)).toBe(expected);
  });

  it('is inert with no argument at all', () => {
    expect(grantAutonomyOffered()).toBe(false);
  });
});

describe('audit vocabulary', () => {
  it('spells the protocol markers once', () => {
    expect(AUTONOMOUS_GATE_INPUT).toBe(
      'Autonomous construction gate per construction protocol module',
    );
    expect(autonomousLoopBackInput(2)).toBe(
      'Autonomous loop-back 2 per construction protocol module',
    );
    expect(GRANT_AUTONOMY_OPTION).toBe('grant-autonomy');
    expect(AUTONOMY_MODE_SET_EVENT).toBe('v2.autonomy.mode_set');
    expect(GATE_AUTO_APPROVED_EVENT).toBe('v2.gate.auto_approved');
    expect(CONSTRUCTION_AUTONOMY_CAPABILITY).toBe('PROTOCOL:construction-autonomy');
  });
});
