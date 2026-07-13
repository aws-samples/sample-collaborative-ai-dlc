import { describe, it, expect } from 'vitest';
import {
  buildExecutionPlan,
  planSegments,
  stageInstanceId,
  workflowScopes,
} from '../v2-execution-plan.js';

// Minimal flat-frontmatter STAGE block (the current model).
const stage = (id, extra = {}) => ({
  blockId: id,
  version: 1,
  phase: extra.phase ?? 'inception',
  mode: extra.mode ?? 'inline',
  leadAgent: extra.leadAgent ?? 'agent-x',
  supportAgents: extra.supportAgents ?? [],
  produces: extra.produces ?? [],
  optionalProduces: extra.optionalProduces ?? [],
  producesKinds: extra.producesKinds ?? null,
  consumes: extra.consumes ?? [],
  requires: extra.requires ?? [],
  blocksOn: extra.blocksOn ?? [],
  sensors: extra.sensors ?? [],
  reviewer: extra.reviewer ?? null,
  reviewerMaxIterations: extra.reviewerMaxIterations,
  humanValidation: extra.humanValidation ?? 'required',
  forEach: extra.forEach ?? null,
  execution: extra.execution,
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

  it('fails a required, unconditional dangling consume when NO stage in the workflow produces it', () => {
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

  it('downgrades a required dangling consume to a warning when the producer exists but is out of scope', () => {
    // The "required when in scope" pattern: units-gen produces the artifact but
    // is SKIP for this scope — a designed scope shortcut, not an authoring bug.
    const lib = baseLibrary({
      stagesById: {
        'units-gen': stage('units-gen', { produces: ['unit-of-work'] }),
        a: stage('a', { consumes: [{ artifact: 'unit-of-work', required: true }] }),
      },
    });
    const wf = workflow([
      { stageId: 'units-gen', order: 0, scopeMembership: { feature: 'SKIP', mvp: 'EXECUTE' } },
      placement('a', 'feature', 1),
    ]);
    const { valid, errors, warnings, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain('scope_absent_consume');
    expect(warnings.find((w) => w.code === 'scope_absent_consume')).toMatchObject({
      stageId: 'a',
      ref: 'unit-of-work',
    });
    // The input is annotated so the prompt/sensors treat the absence as by-design.
    const input = plan.stages
      .find((s) => s.stageId === 'a')
      .inputArtifacts.find((i) => i.artifact === 'unit-of-work');
    expect(input.expectedAbsent).toBe(true);
    expect(input.producedBy).toEqual([]);
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

  it('warns (non-fatal) about a placement wired to EXECUTE in NO scope', () => {
    // Field incident: the composer stored scopeMembership {} on add — the
    // stage silently never ran in any scope, with no signal anywhere.
    const lib = baseLibrary({
      stagesById: {
        a: stage('a'),
        'reverse-engineering': stage('reverse-engineering'),
      },
    });
    const wf = workflow([
      placement('a', 'feature', 0),
      { stageId: 'reverse-engineering', order: 1, scopeMembership: {} },
    ]);
    const { valid, errors, warnings, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings.find((w) => w.code === 'zero_scope_placement')).toMatchObject({
      stageId: 'reverse-engineering',
    });
    // The un-wired stage is (correctly) not part of the plan.
    expect(plan.stages.map((s) => s.stageId)).toEqual(['a']);
  });

  it('does NOT warn about a stage wired to EXECUTE in some other scope', () => {
    const lib = baseLibrary({ stagesById: { a: stage('a'), b: stage('b') } });
    const wf = workflow([
      placement('a', 'feature', 0),
      { stageId: 'b', order: 1, scopeMembership: { mvp: 'EXECUTE', feature: 'SKIP' } },
    ]);
    const { warnings } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(warnings.filter((w) => w.code === 'zero_scope_placement')).toEqual([]);
  });

  it('lists the authored-but-out-of-scope stages on the plan (rewind guard input)', () => {
    const lib = baseLibrary({
      stagesById: { a: stage('a'), b: stage('b'), c: stage('c') },
    });
    const wf = workflow([
      placement('a', 'feature', 0),
      { stageId: 'b', order: 1, scopeMembership: { mvp: 'EXECUTE', feature: 'SKIP' } },
      { stageId: 'c', order: 2, scopeMembership: {} },
    ]);
    const { plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(plan.stages.map((s) => s.stageId)).toEqual(['a']);
    expect(plan.outOfScopeStageIds).toEqual(['b', 'c']);
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

  it('reorders a mis-authored `order` so a stage never precedes its dependency', () => {
    // The real `approval-handoff` bug shape: the gate carries a LOWER authored
    // `order` than the stages producing/requiring its inputs (alphabetical seed
    // sort put "approval-handoff" first). The resolver must linearize by the
    // dependency edges, not the authored order, since the orchestrator runs the
    // sequence verbatim.
    const lib = baseLibrary({
      stagesById: {
        gate: stage('gate', {
          consumes: [{ artifact: 'spec', required: true }],
          requires: ['producer'],
        }),
        producer: stage('producer', { produces: ['spec'] }),
      },
      artifactsById: { spec: { id: 'spec', terminal: false } },
    });
    // gate authored FIRST (order 0), producer SECOND (order 1) — the bug.
    const wf = workflow([placement('gate', 'feature', 0), placement('producer', 'feature', 1)]);
    const { valid, plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(true);
    expect(plan.stages.map((s) => s.stageId)).toEqual(['producer', 'gate']);
  });

  it('keeps authored order as the tiebreak among independent stages', () => {
    const lib = baseLibrary({
      stagesById: { a: stage('a'), b: stage('b'), c: stage('c') },
    });
    // No dependencies between them → authored order is preserved.
    const wf = workflow([
      placement('b', 'feature', 0),
      placement('a', 'feature', 1),
      placement('c', 'feature', 2),
    ]);
    const { valid, plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(true);
    expect(plan.stages.map((s) => s.stageId)).toEqual(['b', 'a', 'c']);
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

  // Upstream validate-grid `summary` (2.2.12): the scope-confirmation UI reads
  // the exact run-shape counts verbatim instead of re-deriving them.
  it('summarizes the run shape: N of T stages, approval gates, per-unit fan-out', () => {
    const lib = baseLibrary({
      stagesById: {
        gen: stage('gen', { produces: ['unit-of-work-dependency'], humanValidation: 'required' }),
        fan: stage('fan', {
          forEach: 'unit-of-work',
          humanValidation: 'none',
          consumes: [{ artifact: 'unit-of-work-dependency', required: true }],
        }),
        quiet: stage('quiet', { humanValidation: 'none' }),
        out: stage('out'),
      },
      artifactsById: { 'unit-of-work-dependency': { id: 'unit-of-work-dependency' } },
    });
    const wf = workflow([
      placement('gen', 'feature', 0),
      { stageId: 'fan', order: 1, scopeMembership: { feature: 'EXECUTE' } },
      placement('quiet', 'feature', 2),
      // Scope-excluded placement → counts toward T, not N.
      { stageId: 'out', order: 3, scopeMembership: { feature: 'SKIP' } },
    ]);
    const { valid, plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(true);
    expect(plan.summary).toEqual({
      executedStages: 3,
      totalStages: 4,
      approvalGates: 1,
      perUnitStages: 1,
      skippedStages: 0,
      outOfScopeStages: 1,
    });
  });

  it('the summary tracks the per-intent skip overlay (skipped stages leave N and the gate count)', () => {
    const lib = baseLibrary({
      stagesById: {
        a: stage('a', { humanValidation: 'required' }),
        b: stage('b', { humanValidation: 'required', execution: 'CONDITIONAL' }),
        c: stage('c', { humanValidation: 'none' }),
      },
    });
    const wf = workflow([
      placement('a', 'feature', 0),
      placement('b', 'feature', 1),
      placement('c', 'feature', 2),
    ]);
    const { valid, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
      skipStageIds: ['b'],
    });
    expect(valid).toBe(true);
    expect(plan.summary).toEqual({
      executedStages: 2,
      totalStages: 3,
      approvalGates: 1,
      perUnitStages: 0,
      skippedStages: 1,
      outOfScopeStages: 0,
    });
  });
});

// ── WP4: unit dimension + parallel sections (docs/v2-parallel.md A2) ─────────

describe('stageInstanceId — unit dimension', () => {
  it('is deterministic per (namespace, stage, unit) and distinct from the unitless id', () => {
    expect(stageInstanceId('e1', 'code-generation', 'auth')).toBe(
      stageInstanceId('e1', 'code-generation', 'auth'),
    );
    expect(stageInstanceId('e1', 'code-generation', 'auth')).not.toBe(
      stageInstanceId('e1', 'code-generation'),
    );
    expect(stageInstanceId('e1', 'code-generation', 'auth')).not.toBe(
      stageInstanceId('e1', 'code-generation', 'billing'),
    );
  });

  it('a null unit slug is exactly the unitless id (backward compatible)', () => {
    expect(stageInstanceId('e1', 'a', null)).toBe(stageInstanceId('e1', 'a'));
  });
});

// Library fixture for section tests: units-gen produces the DAG artifact;
// fd/cg are the per-unit construction stages; bt is the fan-in.
const sectionLibrary = () =>
  baseLibrary({
    stagesById: {
      'units-gen': stage('units-gen', { produces: ['unit-of-work-dependency'] }),
      fd: stage('fd', {
        forEach: 'unit-of-work',
        execution: 'CONDITIONAL',
        consumes: [{ artifact: 'unit-of-work-dependency', required: true }],
      }),
      cg: stage('cg', { forEach: 'unit-of-work', execution: 'ALWAYS', requires: ['fd'] }),
      bt: stage('bt', { requires: ['cg'] }),
    },
    artifactsById: { 'unit-of-work-dependency': { id: 'unit-of-work-dependency' } },
  });

const sectionWorkflow = () =>
  workflow([
    placement('units-gen', 'feature', 0),
    placement('fd', 'feature', 1),
    placement('cg', 'feature', 2),
    placement('bt', 'feature', 3),
  ]);

describe('buildExecutionPlan — parallel sections', () => {
  it('detects a contiguous forEach run as one 1-based section and stamps entries', () => {
    const { valid, plan } = buildExecutionPlan({
      workflow: sectionWorkflow(),
      scope: 'feature',
      library: sectionLibrary(),
    });
    expect(valid).toBe(true);
    expect(plan.sections).toEqual([{ index: 1, stageIds: ['fd', 'cg'] }]);
    const byId = Object.fromEntries(plan.stages.map((s) => [s.stageId, s]));
    expect(byId['units-gen'].parallelSection).toBeNull();
    expect(byId.fd.parallelSection).toBe(1);
    expect(byId.cg.parallelSection).toBe(1);
    expect(byId.bt.parallelSection).toBeNull();
    expect(byId.fd.forEach).toBe('unit-of-work');
    expect(byId.fd.execution).toBe('CONDITIONAL');
    expect(byId.cg.execution).toBe('ALWAYS');
  });

  it('exposes the instance-id namespace on the plan for runtime per-unit ids', () => {
    const { plan } = buildExecutionPlan({
      workflow: sectionWorkflow(),
      scope: 'feature',
      library: sectionLibrary(),
    });
    expect(plan.namespace).toBe('aidlc-v2@1');
    const fd = plan.stages.find((s) => s.stageId === 'fd');
    expect(fd.stageInstanceId).toBe(stageInstanceId('aidlc-v2@1', 'fd'));
  });

  it('splits non-contiguous forEach runs into N sections generically', () => {
    const lib = baseLibrary({
      stagesById: {
        'units-gen': stage('units-gen', { produces: ['unit-of-work-dependency'] }),
        s1a: stage('s1a', { forEach: 'unit-of-work', requires: ['units-gen'] }),
        mid: stage('mid', { requires: ['s1a'] }),
        s2a: stage('s2a', { forEach: 'unit-of-work', requires: ['mid'] }),
        s2b: stage('s2b', { forEach: 'unit-of-work', requires: ['s2a'] }),
        end: stage('end', { requires: ['s2b'] }),
      },
      artifactsById: { 'unit-of-work-dependency': { id: 'unit-of-work-dependency' } },
    });
    const wf = workflow(
      ['units-gen', 's1a', 'mid', 's2a', 's2b', 'end'].map((id, i) => placement(id, 'feature', i)),
    );
    const { valid, plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(valid).toBe(true);
    expect(plan.sections).toEqual([
      { index: 1, stageIds: ['s1a'] },
      { index: 2, stageIds: ['s2a', 's2b'] },
    ]);
  });

  it('fails no_unit_dag_producer when no in-scope upstream stage produces the DAG', () => {
    const lib = baseLibrary({
      stagesById: { cg: stage('cg', { forEach: 'unit-of-work' }) },
    });
    const { valid, errors } = buildExecutionPlan({
      workflow: workflow([placement('cg')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('no_unit_dag_producer');
  });

  it('a DAG producer INSIDE the section does not satisfy its own fan-out gate', () => {
    const lib = baseLibrary({
      stagesById: {
        weird: stage('weird', {
          forEach: 'unit-of-work',
          produces: ['unit-of-work-dependency'],
        }),
      },
      artifactsById: { 'unit-of-work-dependency': { id: 'unit-of-work-dependency' } },
    });
    const { valid, errors } = buildExecutionPlan({
      workflow: workflow([placement('weird')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('no_unit_dag_producer');
  });

  it('fails loudly on a forEach value the engine cannot schedule', () => {
    const lib = baseLibrary({
      stagesById: { odd: stage('odd', { forEach: 'user-story' }) },
    });
    const { valid, errors } = buildExecutionPlan({
      workflow: workflow([placement('odd')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(false);
    const e = errors.find((x) => x.code === 'unsupported_for_each');
    expect(e).toMatchObject({ stageId: 'odd', ref: 'user-story' });
  });

  it('a plan without forEach stages has no sections and stays valid', () => {
    const lib = baseLibrary({ stagesById: { a: stage('a') } });
    const { valid, plan } = buildExecutionPlan({
      workflow: workflow([placement('a')]),
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(plan.sections).toEqual([]);
    expect(plan.stages[0].parallelSection).toBeNull();
  });

  it('an out-of-scope DAG producer DEGRADES the section instead of failing the plan', () => {
    // "Required when in scope": units-gen exists in the workflow but is SKIP for
    // this scope (the lean-scope shortcut, e.g. bugfix/poc skipping
    // units-generation). The section's stages run once per workflow — like
    // upstream's linear walk — with a warning, never a fatal error.
    const lib = sectionLibrary();
    const wf = workflow([
      { stageId: 'units-gen', order: 0, scopeMembership: { feature: 'SKIP' } },
      placement('fd', 'feature', 1),
      placement('cg', 'feature', 2),
    ]);
    const { valid, errors, warnings, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain('scope_absent_unit_dag');
    // fd also consumes unit-of-work-dependency (required) — its producer is the
    // same out-of-scope stage, so it rides the consume warning too.
    expect(warnings.map((w) => w.code)).toContain('scope_absent_consume');
    // Degraded: no sections, no parallelSection stamps, degraded flag set so the
    // runtime's unit-lane invariants stand down.
    expect(plan.sections).toEqual([]);
    const byId = Object.fromEntries(plan.stages.map((s) => [s.stageId, s]));
    expect(byId.fd.parallelSection).toBeNull();
    expect(byId.cg.parallelSection).toBeNull();
    expect(byId.fd.forEachDegraded).toBe(true);
    expect(byId.cg.forEachDegraded).toBe(true);
    // The forEach marker stays truthful (the block still declares it).
    expect(byId.fd.forEach).toBe('unit-of-work');
  });

  it('an in-scope DAG producer placed AFTER the section stays fatal (ordering bug, not a shortcut)', () => {
    // Degradation applies only when the producer is OUT of scope. Here the
    // producer is in scope but topologically after the fan-out — the section
    // could never have a unit plan; that is an authoring bug, not a lean scope.
    const lib = baseLibrary({
      stagesById: {
        early: stage('early', { forEach: 'unit-of-work' }),
        'units-gen': stage('units-gen', {
          produces: ['unit-of-work-dependency'],
          requires: ['early'],
        }),
      },
      artifactsById: { 'unit-of-work-dependency': { id: 'unit-of-work-dependency' } },
    });
    const wf = workflow([placement('early', 'feature', 0), placement('units-gen', 'feature', 1)]);
    const { valid, errors, warnings } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('no_unit_dag_producer');
    expect(warnings.map((w) => w.code)).not.toContain('scope_absent_unit_dag');
  });
});

describe('planSegments', () => {
  it('splits the ordered stages into alternating stage/section segments', () => {
    const { plan } = buildExecutionPlan({
      workflow: sectionWorkflow(),
      scope: 'feature',
      library: sectionLibrary(),
    });
    const segments = planSegments(plan.stages);
    expect(segments.map((s) => s.kind)).toEqual(['stages', 'section', 'stages']);
    expect(segments[0].stages.map((s) => s.stageId)).toEqual(['units-gen']);
    expect(segments[1]).toMatchObject({ index: 1 });
    expect(segments[1].stages.map((s) => s.stageId)).toEqual(['fd', 'cg']);
    expect(segments[2].stages.map((s) => s.stageId)).toEqual(['bt']);
  });

  it('handles empty and section-free inputs', () => {
    expect(planSegments([])).toEqual([]);
    expect(planSegments(undefined)).toEqual([]);
    const flat = planSegments([{ stageId: 'a', parallelSection: null }]);
    expect(flat).toEqual([{ kind: 'stages', stages: [{ stageId: 'a', parallelSection: null }] }]);
  });
});

describe('buildExecutionPlan — per-intent skip overlay (stage-skip.js)', () => {
  // producer(CONDITIONAL) → consumer(required) → tail(ALWAYS): the shape a
  // create-time deselection produces.
  const skipLibrary = () =>
    baseLibrary({
      stagesById: {
        producer: stage('producer', { execution: 'CONDITIONAL', produces: ['doc'] }),
        consumer: stage('consumer', {
          execution: 'CONDITIONAL',
          consumes: [{ artifact: 'doc', required: true }],
        }),
        tail: stage('tail', { execution: 'ALWAYS' }),
        init: stage('init', { phase: 'initialization', execution: 'ALWAYS' }),
      },
    });
  const skipWorkflow = () =>
    workflow([
      placement('init', 'feature', 0),
      placement('producer', 'feature', 1),
      placement('consumer', 'feature', 2),
      placement('tail', 'feature', 3),
    ]);

  it('drops the skipped stage from the plan and reports it on skippedStages with a deterministic instance id', () => {
    const { valid, errors, plan } = buildExecutionPlan({
      workflow: skipWorkflow(),
      scope: 'feature',
      library: skipLibrary(),
      settings: { executionId: 'exec-1' },
      skipStageIds: ['producer'],
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(plan.stages.map((s) => s.stageId)).toEqual(['init', 'consumer', 'tail']);
    expect(plan.skippedStages).toEqual([
      {
        stageId: 'producer',
        phase: 'inception',
        stageInstanceId: stageInstanceId('exec-1', 'producer'),
      },
    ]);
    // Skipped ≠ out-of-scope: the rewind endpoint tells them apart.
    expect(plan.outOfScopeStageIds).not.toContain('producer');
  });

  it('skipping a producer degrades its consumers to the designed expectedAbsent path (never a fatal dangling_consume)', () => {
    const { valid, errors, warnings, plan } = buildExecutionPlan({
      workflow: skipWorkflow(),
      scope: 'feature',
      library: skipLibrary(),
      skipStageIds: ['producer'],
    });
    expect(valid).toBe(true);
    expect(errors.map((e) => e.code)).not.toContain('dangling_consume');
    expect(warnings.map((w) => w.code)).toContain('scope_absent_consume');
    const consumer = plan.stages.find((s) => s.stageId === 'consumer');
    expect(consumer.inputArtifacts.find((i) => i.artifact === 'doc').expectedAbsent).toBe(true);
  });

  it('rejects skipping an ALWAYS stage (skip_not_allowed)', () => {
    const { valid, errors } = buildExecutionPlan({
      workflow: skipWorkflow(),
      scope: 'feature',
      library: skipLibrary(),
      skipStageIds: ['tail'],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('skip_not_allowed');
  });

  it('rejects skipping an initialization stage (skip_not_allowed)', () => {
    const { valid, errors } = buildExecutionPlan({
      workflow: skipWorkflow(),
      scope: 'feature',
      library: skipLibrary(),
      skipStageIds: ['init'],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('skip_not_allowed');
  });

  it('rejects skipping a stage that is not in the scope projection (skip_stage_not_in_scope)', () => {
    const lib = skipLibrary();
    const wf = workflow([
      placement('producer', 'feature', 0),
      // consumer only executes under mvp — skipping it for a feature run is
      // meaningless and therefore an error, not a silent no-op.
      { stageId: 'consumer', order: 1, scopeMembership: { feature: 'SKIP', mvp: 'EXECUTE' } },
      placement('tail', 'feature', 2),
    ]);
    const { valid, errors } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
      skipStageIds: ['consumer'],
    });
    expect(valid).toBe(false);
    expect(errors.map((e) => e.code)).toContain('skip_stage_not_in_scope');
    // Also catches genuinely unknown ids the same way.
    const unknown = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
      skipStageIds: ['nope'],
    });
    expect(unknown.errors.map((e) => e.code)).toContain('skip_stage_not_in_scope');
  });

  it('an empty/absent overlay changes nothing', () => {
    const base = buildExecutionPlan({
      workflow: skipWorkflow(),
      scope: 'feature',
      library: skipLibrary(),
    });
    expect(base.valid).toBe(true);
    expect(base.plan.skippedStages).toEqual([]);
    const withEmpty = buildExecutionPlan({
      workflow: skipWorkflow(),
      scope: 'feature',
      library: skipLibrary(),
      skipStageIds: [],
    });
    expect(withEmpty.plan.stages.map((s) => s.stageId)).toEqual(
      base.plan.stages.map((s) => s.stageId),
    );
  });

  it('skipping the unit-DAG producer degrades the parallel section (scope_absent_unit_dag), matching the scope-shortcut path', () => {
    const lib = baseLibrary({
      stagesById: {
        'units-gen': stage('units-gen', {
          execution: 'CONDITIONAL',
          produces: ['unit-of-work-dependency'],
        }),
        fd: stage('fd', {
          forEach: 'unit-of-work',
          execution: 'CONDITIONAL',
          consumes: [{ artifact: 'unit-of-work-dependency', required: true }],
        }),
      },
      artifactsById: { 'unit-of-work-dependency': { id: 'unit-of-work-dependency' } },
    });
    const wf = workflow([placement('units-gen', 'feature', 0), placement('fd', 'feature', 1)]);
    const { valid, warnings, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
      skipStageIds: ['units-gen'],
    });
    expect(valid).toBe(true);
    expect(warnings.map((w) => w.code)).toContain('scope_absent_unit_dag');
    expect(plan.stages.find((s) => s.stageId === 'fd').forEachDegraded).toBe(true);
  });
});

describe('buildExecutionPlan — optional produces + produces kinds', () => {
  it('an optional producer satisfies a consume edge (ordering + no dangling error)', () => {
    const lib = baseLibrary({
      stagesById: {
        design: stage('design', {
          produces: ['model'],
          optionalProduces: ['frontend-components'],
        }),
        codegen: stage('codegen', {
          consumes: [{ artifact: 'frontend-components', required: false }],
        }),
      },
    });
    const wf = workflow([placement('codegen', 'feature', 0), placement('design', 'feature', 1)]);
    const { valid, errors, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    // The consumer is ordered AFTER its optional producer despite the authored order.
    const order = plan.stages.map((s) => s.stageId);
    expect(order.indexOf('design')).toBeLessThan(order.indexOf('codegen'));
  });

  it('flags optional outputs on the instance contract, required ones untouched', () => {
    const lib = baseLibrary({
      stagesById: {
        design: stage('design', {
          produces: ['model'],
          optionalProduces: ['frontend-components'],
        }),
      },
    });
    const wf = workflow([placement('design')]);
    const { plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    const outputs = plan.stages[0].outputArtifacts;
    expect(outputs).toEqual([
      { artifact: 'model', terminal: null },
      { artifact: 'frontend-components', terminal: null, optional: true },
    ]);
  });

  it('carries producesKinds onto the stage instance for per-unit pruning', () => {
    const lib = baseLibrary({
      stagesById: {
        design: stage('design', {
          produces: ['model'],
          producesKinds: { model: ['service', 'ui'] },
        }),
        bare: stage('bare', { produces: ['doc'] }),
      },
    });
    const wf = workflow([placement('design', 'feature', 0), placement('bare', 'feature', 1)]);
    const { plan } = buildExecutionPlan({ workflow: wf, scope: 'feature', library: lib });
    expect(plan.stages.find((s) => s.stageId === 'design').producesKinds).toEqual({
      model: ['service', 'ui'],
    });
    expect(plan.stages.find((s) => s.stageId === 'bare').producesKinds).toBeNull();
  });

  it('an out-of-scope OPTIONAL producer still classifies as a scope shortcut, not dangling', () => {
    const lib = baseLibrary({
      stagesById: {
        design: stage('design', { optionalProduces: ['frontend-components'] }),
        codegen: stage('codegen', {
          consumes: [{ artifact: 'frontend-components', required: true }],
        }),
      },
    });
    // design only runs in mvp; the feature run consumes without a producer.
    const wf = workflow([
      { stageId: 'design', order: 0, scopeMembership: { mvp: 'EXECUTE', feature: 'SKIP' } },
      placement('codegen', 'feature', 1),
    ]);
    const { valid, warnings, errors } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
    });
    expect(valid).toBe(true);
    expect(errors).toEqual([]);
    expect(warnings.map((w) => w.code)).toContain('scope_absent_consume');
  });
});

describe('buildExecutionPlan — composed grid', () => {
  // A three-stage workflow: init scaffolds, analyze produces what build needs.
  const gridLibrary = () =>
    baseLibrary({
      stagesById: {
        init: stage('init', { phase: 'initialization', humanValidation: 'none' }),
        analyze: stage('analyze', { produces: ['spec'] }),
        build: stage('build', { consumes: [{ artifact: 'spec', required: true }] }),
      },
    });
  const gridWorkflow = () =>
    workflow([
      placement('init', 'feature', 0),
      placement('analyze', 'feature', 1),
      placement('build', 'feature', 2),
    ]);

  it('projects the plan from the grid instead of the scope', () => {
    const { valid, errors, plan } = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'my-composed-label',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(plan.composed).toBe(true);
    expect(plan.scope).toBe('my-composed-label');
    expect(plan.stages.map((s) => s.stageId)).toEqual(['init', 'analyze', 'build']);
  });

  it('does not require the scope label to name a workflow scope', () => {
    const { valid, errors } = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'totally-custom',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(errors.map((e) => e.code)).not.toContain('scope_not_found');
    expect(valid).toBe(true);
  });

  it('a grid-SKIPped stage lands in outOfScopeStageIds, not skippedStages', () => {
    const { valid, plan } = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', build: 'SKIP' },
    });
    expect(valid).toBe(true);
    expect(plan.stages.map((s) => s.stageId)).toEqual(['init', 'analyze']);
    expect(plan.outOfScopeStageIds).toContain('build');
    expect(plan.skippedStages).toEqual([]);
  });

  it('an UNLISTED placement defaults to SKIP', () => {
    const { valid, plan } = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE' },
    });
    expect(valid).toBe(true);
    expect(plan.stages.map((s) => s.stageId)).toEqual(['init', 'analyze']);
    expect(plan.outOfScopeStageIds).toContain('build');
  });

  it('rejects skipping (or omitting) an initialization stage', () => {
    const omitted = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(omitted.valid).toBe(false);
    expect(omitted.errors.map((e) => e.code)).toContain('composed_grid_initialization_skip');

    const skipped = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'SKIP', analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(skipped.valid).toBe(false);
    expect(skipped.errors.map((e) => e.code)).toContain('composed_grid_initialization_skip');
  });

  it('rejects unknown stages, bad values, empty and all-SKIP grids', () => {
    const unknown = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', ghost: 'EXECUTE' },
    });
    expect(unknown.valid).toBe(false);
    expect(unknown.errors.map((e) => e.code)).toContain('composed_grid_unknown_stage');

    const badValue = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'maybe' },
    });
    expect(badValue.valid).toBe(false);
    expect(badValue.errors.map((e) => e.code)).toContain('composed_grid_invalid');

    const empty = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: {},
    });
    expect(empty.valid).toBe(false);
    expect(empty.errors.map((e) => e.code)).toContain('composed_grid_invalid');
  });

  it('a starved required input is a lenient warning by default, a strict error on demand', () => {
    const grid = { init: 'EXECUTE', analyze: 'SKIP', build: 'EXECUTE' };
    const lenient = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: grid,
    });
    expect(lenient.valid).toBe(true);
    expect(lenient.warnings.map((w) => w.code)).toContain('scope_absent_consume');
    const buildStage = lenient.plan.stages.find((s) => s.stageId === 'build');
    expect(buildStage.inputArtifacts.find((i) => i.artifact === 'spec').expectedAbsent).toBe(true);

    const strict = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: grid,
      strict: true,
    });
    expect(strict.valid).toBe(false);
    expect(strict.errors.map((e) => e.code)).toContain('starved_consume');
  });

  it('the skip overlay still applies ON TOP of the grid projection', () => {
    const lib = baseLibrary({
      stagesById: {
        init: stage('init', { phase: 'initialization', humanValidation: 'none' }),
        analyze: stage('analyze', { produces: ['spec'] }),
        extra: stage('extra', { execution: 'CONDITIONAL' }),
        build: stage('build', { consumes: [{ artifact: 'spec', required: true }] }),
      },
    });
    const wf = workflow([
      placement('init', 'feature', 0),
      placement('analyze', 'feature', 1),
      placement('extra', 'feature', 2),
      placement('build', 'feature', 3),
    ]);
    const { valid, errors, plan } = buildExecutionPlan({
      workflow: wf,
      scope: 'feature',
      library: lib,
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', extra: 'EXECUTE', build: 'EXECUTE' },
      skipStageIds: ['extra'],
    });
    expect(errors).toEqual([]);
    expect(valid).toBe(true);
    expect(plan.stages.map((s) => s.stageId)).toEqual(['init', 'analyze', 'build']);
    expect(plan.skippedStages.map((s) => s.stageId)).toEqual(['extra']);
    expect(plan.summary.skippedStages).toBe(1);
  });

  it('grid projection keeps instance ids identical to the scope projection', () => {
    const scoped = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
    });
    const composed = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', build: 'EXECUTE' },
    });
    expect(composed.plan.stages.map((s) => s.stageInstanceId)).toEqual(
      scoped.plan.stages.map((s) => s.stageInstanceId),
    );
  });

  it('summary counts hold under a grid projection', () => {
    const { plan } = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
      composedGrid: { init: 'EXECUTE', analyze: 'EXECUTE', build: 'SKIP' },
    });
    expect(plan.summary).toEqual({
      executedStages: 2,
      totalStages: 3,
      approvalGates: 1, // analyze only — init is humanValidation none
      perUnitStages: 0,
      skippedStages: 0,
      outOfScopeStages: 1,
    });
  });

  it('plans without a grid stay non-composed', () => {
    const { plan } = buildExecutionPlan({
      workflow: gridWorkflow(),
      scope: 'feature',
      library: gridLibrary(),
    });
    expect(plan.composed).toBe(false);
  });
});
