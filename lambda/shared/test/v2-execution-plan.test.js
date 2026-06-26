import { describe, it, expect } from 'vitest';
import { buildExecutionPlan, stageInstanceId, workflowScopes } from '../v2-execution-plan.js';

// Minimal flat-frontmatter STAGE block (the current model).
const stage = (id, extra = {}) => ({
  blockId: id,
  version: 1,
  phase: extra.phase ?? 'inception',
  mode: extra.mode ?? 'inline',
  leadAgent: extra.leadAgent ?? 'agent-x',
  supportAgents: extra.supportAgents ?? [],
  produces: extra.produces ?? [],
  consumes: extra.consumes ?? [],
  requires: extra.requires ?? [],
  blocksOn: extra.blocksOn ?? [],
  sensors: extra.sensors ?? [],
  reviewer: extra.reviewer ?? null,
  reviewerMaxIterations: extra.reviewerMaxIterations,
  humanValidation: extra.humanValidation ?? 'required',
});

const placement = (stageId, scope = 'feature', order = 0) => ({
  stageId,
  order,
  scopeMembership: { [scope]: 'EXECUTE' },
});

const baseLibrary = (overrides = {}) => ({
  stagesById: {},
  agentsById: { 'agent-x': { blockId: 'agent-x' }, reviewer: { blockId: 'reviewer' } },
  sensorsById: {
    linter: { command: 'aidlc-sensor-linter.ts', severity: 'blocking', runtime: 'bun' },
  },
  rulesById: {},
  artifactsById: {},
  ...overrides,
});

const workflow = (placements, extra = {}) => ({
  id: 'aidlc-v2',
  version: 1,
  placements,
  ruleRefs: extra.ruleRefs ?? [],
  ...extra,
});

describe('stageInstanceId', () => {
  it('is deterministic for the same namespace + stage', () => {
    expect(stageInstanceId('exec-1', 'requirements')).toBe(
      stageInstanceId('exec-1', 'requirements'),
    );
  });
  it('differs across namespaces and stages', () => {
    expect(stageInstanceId('exec-1', 'a')).not.toBe(stageInstanceId('exec-2', 'a'));
    expect(stageInstanceId('exec-1', 'a')).not.toBe(stageInstanceId('exec-1', 'b'));
  });
});

describe('workflowScopes', () => {
  it('derives from placement membership when no scope refs', () => {
    const wf = workflow([placement('a', 'mvp'), placement('b', 'enterprise')]);
    expect([...workflowScopes(wf)].toSorted()).toEqual(['enterprise', 'mvp']);
  });
});

describe('buildExecutionPlan — validation', () => {
  it('rejects a non-positive-integer version', () => {
    const wf = workflow([placement('a')], { version: 'latest' });
    const lib = baseLibrary({ stagesById: { a: stage('a') } });
    const { valid, errors } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('workflow_version_missing');
  });

  it('rejects an unknown scope and builds nothing', () => {
    const wf = workflow([placement('a')]);
    const { valid, plan, errors } = buildExecutionPlan({
      workflow: wf,
      scope: 'nope',
      library: baseLibrary(),
    });
    expect(valid).toBe(false);
    expect(plan).toBeNull();
    expect(errors[0].code).toBe('scope_not_found');
  });

  it('flags an unresolved lead agent', () => {
    const lib = baseLibrary({ stagesById: { a: stage('a', { leadAgent: 'ghost' }) } });
    const { valid, errors } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('unresolved_agent');
  });

  it('exempts the reserved "orchestrator" lead agent (the conductor, no AGENT block)', () => {
    // Mirrors upstream initialization stages (workspace-scaffold/-detection/
    // state-init) which declare lead_agent: orchestrator with no agent file.
    const lib = baseLibrary({ stagesById: { a: stage('a', { leadAgent: 'orchestrator' }) } });
    const { valid, errors, plan } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(errors.map((e) => e.code)).not.toContain('unresolved_agent');
    expect(valid).toBe(true);
    expect(plan.stages.find((s) => s.stageId === 'a').agentRef).toBe('orchestrator');
  });

  it('fails a required, unconditional dangling consume', () => {
    const lib = baseLibrary({
      stagesById: { a: stage('a', { consumes: [{ artifact: 'missing', required: true }] }) },
    });
    const { valid, errors } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('dangling_consume');
  });

  it('allows an optional dangling consume', () => {
    const lib = baseLibrary({
      stagesById: { a: stage('a', { consumes: [{ artifact: 'opt', required: false }] }) },
    });
    const { valid } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
  });
});

describe('buildExecutionPlan — plan shape', () => {
  it('wires produces→consumes into dependencies and orders by plan order', () => {
    const lib = baseLibrary({
      stagesById: {
        producer: stage('producer', { produces: ['spec'], order: 0 }),
        consumer: stage('consumer', { consumes: [{ artifact: 'spec', required: true }] }),
      },
      artifactsById: { spec: { id: 'spec', terminal: false } },
    });
    const wf = workflow([placement('producer', 'feature', 0), placement('consumer', 'feature', 1)]);
    const { valid, plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(true);
    const consumer = plan.stages.find((s) => s.stageId === 'consumer');
    const producer = plan.stages.find((s) => s.stageId === 'producer');
    expect(consumer.dependencyStageIds).toEqual(['producer']);
    expect(consumer.inputArtifacts[0].producedBy).toEqual(['producer']);
    expect(producer.outputArtifacts[0]).toEqual({ artifact: 'spec', terminal: false });
  });

  it('resolves the reviewer axis as its own field (not a sensor)', () => {
    const lib = baseLibrary({
      stagesById: { a: stage('a', { reviewer: 'reviewer', reviewerMaxIterations: 3 }) },
    });
    const { valid, plan } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(plan.stages[0].reviewer).toEqual({ reviewerAgent: 'reviewer', maxIterations: 3 });
    expect(plan.stages[0].sensors).toEqual([]);
  });

  it('resolves deterministic sensors with their command', () => {
    const lib = baseLibrary({ stagesById: { a: stage('a', { sensors: ['linter'] }) } });
    const { plan } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(plan.stages[0].sensors[0]).toMatchObject({
      sensorId: 'linter',
      command: 'aidlc-sensor-linter.ts',
      runtime: 'bun',
    });
  });

  it('flags agent-team as not implemented without crashing', () => {
    const lib = baseLibrary({ stagesById: { a: stage('a', { mode: 'agent-team' }) } });
    const { plan } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(plan.stages[0].notImplemented).toBe(true);
    expect(plan.stages[0].runtimeError).toBe('not_implemented');
  });

  it('only includes EXECUTE placements for the selected scope', () => {
    const lib = baseLibrary({ stagesById: { a: stage('a'), b: stage('b') } });
    const wf = workflow([
      { stageId: 'a', order: 0, scopeMembership: { feature: 'EXECUTE', mvp: 'SKIP' } },
      { stageId: 'b', order: 1, scopeMembership: { feature: 'SKIP', mvp: 'EXECUTE' } },
    ]);
    const { plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(plan.stages.map((s) => s.stageId)).toEqual(['a']);
  });
});
