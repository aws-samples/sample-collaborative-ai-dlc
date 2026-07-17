import { describe, it, expect } from 'vitest';
import {
  compileScopeGrid,
  compileAutonomyProfile,
  compileStageGraph,
  compileRules,
  stageAutonomy,
} from '../compile.js';

// A library Stage block, minimally shaped for the compilers — flat V2 fields.
const stage = (
  id,
  {
    reviewer,
    sensors,
    humanValidation,
    inputs,
    outputs,
    requires,
    blocksOn,
    forEach,
    execution,
  } = {},
) => ({
  blockId: id,
  // Verification axes: deterministic sensors, an LLM-judged reviewer agent, the
  // human gate.
  sensors: sensors ?? [],
  reviewer: reviewer ?? null,
  humanValidation: humanValidation ?? 'none',
  // DAG edges (flat).
  consumes: inputs ?? [],
  produces: outputs ?? [],
  requires: requires ?? [],
  blocksOn: blocksOn ?? [],
  forEach: forEach ?? null,
  execution: execution ?? null,
});

const placement = (stageId, scopeMembership = {}, extra = {}) => ({
  stageId,
  phasePath: extra.phasePath ?? null,
  order: extra.order ?? 0,
  scopeMembership,
});

describe('compileScopeGrid', () => {
  it('transposes membership and defaults unlisted scopes to SKIP', () => {
    const placements = [
      placement('a', { mvp: 'EXECUTE', enterprise: 'EXECUTE' }),
      placement('b', { enterprise: 'EXECUTE' }),
    ];
    const grid = compileScopeGrid(placements, ['mvp', 'enterprise']);
    expect(grid).toEqual({
      mvp: { a: 'EXECUTE', b: 'SKIP' },
      enterprise: { a: 'EXECUTE', b: 'EXECUTE' },
    });
  });

  it('treats any non-EXECUTE value as SKIP', () => {
    const grid = compileScopeGrid([placement('a', { mvp: 'SKIP' })], ['mvp']);
    expect(grid.mvp.a).toBe('SKIP');
  });
});

describe('stageAutonomy — three verification axes', () => {
  it('self-halting: deterministic sensors only (advisory, no human in loop)', () => {
    expect(stageAutonomy(stage('s', { sensors: ['linter'] }))).toBe('self-halting');
  });

  it('self-halting: no verification at all', () => {
    expect(stageAutonomy(stage('s'))).toBe('self-halting');
  });

  it('human-gated: humanValidation required', () => {
    expect(stageAutonomy(stage('s', { humanValidation: 'required' }))).toBe('human-gated');
  });

  it('human-gated: required gate wins even with a reviewer', () => {
    expect(
      stageAutonomy(
        stage('s', { humanValidation: 'required', reviewer: 'aidlc-product-lead-agent' }),
      ),
    ).toBe('human-gated');
  });

  it('mixed: a reviewer without an unconditional human gate', () => {
    expect(stageAutonomy(stage('s', { reviewer: 'aidlc-architecture-reviewer-agent' }))).toBe(
      'mixed',
    );
  });

  it('mixed: a reviewer alongside deterministic sensors', () => {
    expect(
      stageAutonomy(stage('s', { sensors: ['linter'], reviewer: 'aidlc-product-lead-agent' })),
    ).toBe('mixed');
  });

  it('mixed: conditional human validation', () => {
    expect(stageAutonomy(stage('s', { humanValidation: 'conditional' }))).toBe('mixed');
  });
});

describe('compileAutonomyProfile', () => {
  it('rolls up per-stage levels', () => {
    const stagesById = {
      a: stage('a', { sensors: ['linter'] }), // self-halting
      b: stage('b', { humanValidation: 'required' }), // human-gated
      c: stage('c', { reviewer: 'aidlc-product-lead-agent' }), // mixed
    };
    const { perStage, rollup } = compileAutonomyProfile(
      [placement('a'), placement('b'), placement('c')],
      stagesById,
    );
    expect(perStage).toEqual({ a: 'self-halting', b: 'human-gated', c: 'mixed' });
    expect(rollup).toEqual({ selfHalting: 1, mixed: 1, humanGated: 1, total: 3 });
  });
});

describe('compileStageGraph', () => {
  it('wires produces→consumes edges', () => {
    const stagesById = {
      a: stage('a', { outputs: ['doc'] }),
      b: stage('b', { inputs: [{ artifact: 'doc', required: true }] }),
    };
    const graph = compileStageGraph([placement('a'), placement('b')], stagesById);
    expect(graph.acyclic).toBe(true);
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b', artifact: 'doc', kind: 'data' });
    expect(graph.danglingConsumes).toEqual([]);
  });

  it('adds branch and execution metadata to graph nodes', () => {
    const stagesById = {
      a: stage('a', { forEach: 'unit-of-work', execution: 'CONDITIONAL' }),
      b: stage('b', { forEach: 'unit-of-work', execution: 'ALWAYS' }),
      c: stage('c', { forEach: 'user-story' }),
    };
    const graph = compileStageGraph([placement('a'), placement('b'), placement('c')], stagesById);
    expect(graph.nodes.find((n) => n.stageId === 'a')).toMatchObject({
      forEach: 'unit-of-work',
      execution: 'CONDITIONAL',
      section: 1,
      branch: { forEach: 'unit-of-work', supported: true, section: 1 },
    });
    expect(graph.nodes.find((n) => n.stageId === 'b').section).toBe(1);
    expect(graph.nodes.find((n) => n.stageId === 'c')).toMatchObject({
      forEach: 'user-story',
      branch: { forEach: 'user-story', supported: false, section: null },
      section: null,
    });
  });

  it('flags a consumed-but-never-produced artifact', () => {
    const stagesById = { b: stage('b', { inputs: [{ artifact: 'ghost', required: true }] }) };
    const graph = compileStageGraph([placement('b')], stagesById);
    expect(graph.danglingConsumes).toContainEqual({ stageId: 'b', artifact: 'ghost' });
  });

  it('flags a produced-but-never-consumed artifact (orphan warning)', () => {
    const stagesById = { a: stage('a', { outputs: ['unused'] }) };
    const graph = compileStageGraph([placement('a')], stagesById);
    // No registry supplied → terminal is unknown (null), reads as a warning.
    expect(graph.orphanProduces).toContainEqual({
      artifact: 'unused',
      producedBy: ['a'],
      terminal: null,
    });
  });

  it('tags an orphan terminal:true for a registered terminal artifact, false otherwise', () => {
    const stagesById = { a: stage('a', { outputs: ['final-report', 'forgot-to-wire'] }) };
    // Registry marks final-report terminal (deliberate end-of-flow); the other
    // name is registered but not terminal (a genuine unwired producer).
    const registry = {
      'final-report': { blockId: 'final-report', terminal: true },
      'forgot-to-wire': { blockId: 'forgot-to-wire', terminal: false },
    };
    const graph = compileStageGraph([placement('a')], stagesById, registry);
    expect(graph.orphanProduces).toContainEqual({
      artifact: 'final-report',
      producedBy: ['a'],
      terminal: true,
    });
    expect(graph.orphanProduces).toContainEqual({
      artifact: 'forgot-to-wire',
      producedBy: ['a'],
      terminal: false,
    });
  });

  it('detects a cycle via produces/consumes', () => {
    const stagesById = {
      a: stage('a', { outputs: ['x'], inputs: [{ artifact: 'y' }] }),
      b: stage('b', { outputs: ['y'], inputs: [{ artifact: 'x' }] }),
    };
    const graph = compileStageGraph([placement('a'), placement('b')], stagesById);
    expect(graph.acyclic).toBe(false);
    expect(graph.cycles.toSorted()).toEqual(['a', 'b']);
  });

  it('adds requires ordering edges only for placed skills', () => {
    const stagesById = {
      a: stage('a'),
      b: stage('b', { requires: ['a', 'not-placed'] }),
    };
    const graph = compileStageGraph([placement('a'), placement('b')], stagesById);
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b', kind: 'requires' });
    expect(graph.edges.filter((e) => e.from === 'not-placed')).toEqual([]);
  });

  it('reports no unknownArtifacts when no registry is supplied', () => {
    const stagesById = { a: stage('a', { outputs: ['doc'] }) };
    const graph = compileStageGraph([placement('a')], stagesById);
    expect(graph.unknownArtifacts).toEqual([]);
  });

  it('flags produced/consumed names absent from the artifact registry', () => {
    const stagesById = {
      a: stage('a', { outputs: ['doc', 'typoo'] }),
      b: stage('b', { inputs: [{ artifact: 'doc', required: true }] }),
    };
    // Registry knows `doc` but not `typoo` — the typo case orphanProduces can't
    // distinguish from a deliberate terminal output.
    const registry = { doc: { blockId: 'doc' } };
    const graph = compileStageGraph([placement('a'), placement('b')], stagesById, registry);
    expect(graph.unknownArtifacts).toContainEqual({
      artifact: 'typoo',
      stageId: 'a',
      role: 'produces',
    });
    expect(graph.unknownArtifacts.find((u) => u.artifact === 'doc')).toBeUndefined();
  });
});

describe('compileRules', () => {
  // A library Rule block, shaped as a stored item (blockId + layer + phase).
  const rule = (id, layer, phase = null) => ({ blockId: id, id, layer, phase });
  // A stage block here only needs its (flat) phase field.
  const phaseStage = (id, phase) => ({ blockId: id, phase });

  const rulesById = {
    'r-org': rule('r-org', 'org'),
    'r-team': rule('r-team', 'team'),
    'r-ideation': rule('r-ideation', 'phase', 'ideation'),
    'r-construction': rule('r-construction', 'phase', 'construction'),
  };
  const ruleRefs = [
    { ruleId: 'r-org', layer: 'org' },
    { ruleId: 'r-team', layer: 'team' },
    { ruleId: 'r-ideation', layer: 'phase' },
    { ruleId: 'r-construction', layer: 'phase' },
  ];

  it('applies universal layers to every stage and phase rules by phase match', () => {
    const stagesById = {
      a: phaseStage('a', 'ideation'),
      b: phaseStage('b', 'construction'),
      c: phaseStage('c', 'initialization'),
    };
    const out = compileRules(
      [placement('a'), placement('b'), placement('c')],
      ruleRefs,
      rulesById,
      stagesById,
    );
    expect(out.universal.map((u) => u.ruleId)).toEqual(['r-org', 'r-team']);
    expect(out.perStage.a).toEqual({ universal: ['r-org', 'r-team'], phase: ['r-ideation'] });
    expect(out.perStage.b).toEqual({ universal: ['r-org', 'r-team'], phase: ['r-construction'] });
    // initialization has no phase rule → universal only.
    expect(out.perStage.c).toEqual({ universal: ['r-org', 'r-team'], phase: [] });
  });

  it('reports a ref whose rule block is missing as unresolved', () => {
    const out = compileRules([placement('a')], [{ ruleId: 'ghost', layer: 'org' }], rulesById, {
      a: phaseStage('a', 'ideation'),
    });
    expect(out.unresolved).toEqual(['ghost']);
  });

  it('admits the two learnings tiers as universal layers, priority-sorted', () => {
    const withLearnings = {
      ...rulesById,
      'r-team-learn': rule('r-team-learn', 'team-learnings'),
      'r-proj-learn': rule('r-proj-learn', 'project-learnings'),
      'r-project': rule('r-project', 'project'),
    };
    // Deliberately out of order to prove the compiler sorts by layer priority.
    const refs = [
      { ruleId: 'r-proj-learn', layer: 'project-learnings' },
      { ruleId: 'r-org', layer: 'org' },
      { ruleId: 'r-project', layer: 'project' },
      { ruleId: 'r-team-learn', layer: 'team-learnings' },
      { ruleId: 'r-team', layer: 'team' },
    ];
    const out = compileRules([placement('a')], refs, withLearnings, {
      a: phaseStage('a', 'ideation'),
    });
    // org → team → team-learnings → project → project-learnings.
    expect(out.universal.map((u) => u.ruleId)).toEqual([
      'r-org',
      'r-team',
      'r-team-learn',
      'r-project',
      'r-proj-learn',
    ]);
  });

  it('surfaces rule→sensor pairings (the feedforward/feedback link)', () => {
    const paired = {
      'r-org': { blockId: 'r-org', layer: 'org', pairing: 'required-sections' },
      'r-team': { blockId: 'r-team', layer: 'team', pairing: 'feedforward-only' },
    };
    const out = compileRules(
      [placement('a')],
      [
        { ruleId: 'r-org', layer: 'org' },
        { ruleId: 'r-team', layer: 'team' },
      ],
      paired,
      { a: phaseStage('a', 'ideation') },
    );
    expect(out.pairings).toContainEqual({ ruleId: 'r-org', sensor: 'required-sections' });
    expect(out.pairings).toContainEqual({ ruleId: 'r-team', sensor: 'feedforward-only' });
  });
});

describe('compileStageGraph — blocks_on ordering edges', () => {
  it('emits a kind:blocks edge for a placed blocksOn dependency', () => {
    const stagesById = {
      a: stage('a'),
      b: stage('b', { blocksOn: ['a'] }),
    };
    const graph = compileStageGraph([placement('a'), placement('b')], stagesById);
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b', kind: 'blocks' });
  });

  it('counts a blocksOn edge in cycle detection', () => {
    // a blocks-on b AND b blocks-on a → a cycle even with no data edges.
    const stagesById = { a: stage('a', { blocksOn: ['b'] }), b: stage('b', { blocksOn: ['a'] }) };
    const graph = compileStageGraph([placement('a'), placement('b')], stagesById);
    expect(graph.acyclic).toBe(false);
  });
});
