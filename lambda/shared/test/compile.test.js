import { describe, it, expect } from 'vitest';
import {
  compileScopeGrid,
  compileAutonomyProfile,
  compileStageGraph,
  stageAutonomy,
} from '../compile.js';

// A library Stage block, minimally shaped for the compilers.
const stage = (
  id,
  { clarification, sensors, humanValidation, inputs, outputs, requires } = {},
) => ({
  blockId: id,
  clarification: clarification ? { required: clarification } : undefined,
  c2_verification: {
    sensors: sensors ?? [],
    humanValidation: humanValidation ?? 'none',
  },
  c1_definition: {
    inputs: inputs ?? [],
    outputs: outputs ?? [],
    intermediates: [],
    requires: requires ?? [],
  },
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

describe('stageAutonomy — both gates', () => {
  it('self-halting: no clarification, all deterministic', () => {
    expect(stageAutonomy(stage('s', { sensors: [{ mode: 'deterministic' }] }))).toBe(
      'self-halting',
    );
  });

  it('self-halting: no gates at all', () => {
    expect(stageAutonomy(stage('s'))).toBe('self-halting');
  });

  it('human-gated: front gate open (clarification always)', () => {
    expect(
      stageAutonomy(stage('s', { clarification: 'always', sensors: [{ mode: 'deterministic' }] })),
    ).toBe('human-gated');
  });

  it('human-gated: humanValidation required', () => {
    expect(stageAutonomy(stage('s', { humanValidation: 'required' }))).toBe('human-gated');
  });

  it('human-gated: only llm-judged sensors', () => {
    expect(stageAutonomy(stage('s', { sensors: [{ mode: 'llm-judged' }] }))).toBe('human-gated');
  });

  it('mixed: both deterministic and llm-judged', () => {
    expect(
      stageAutonomy(stage('s', { sensors: [{ mode: 'deterministic' }, { mode: 'llm-judged' }] })),
    ).toBe('mixed');
  });

  it('mixed: conditional clarification with deterministic checks', () => {
    expect(
      stageAutonomy(
        stage('s', { clarification: 'conditional', sensors: [{ mode: 'deterministic' }] }),
      ),
    ).toBe('mixed');
  });
});

describe('compileAutonomyProfile', () => {
  it('rolls up per-stage levels', () => {
    const stagesById = {
      a: stage('a', { sensors: [{ mode: 'deterministic' }] }), // self-halting
      b: stage('b', { sensors: [{ mode: 'llm-judged' }] }), // human-gated
      c: stage('c', { sensors: [{ mode: 'deterministic' }, { mode: 'llm-judged' }] }), // mixed
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

  it('flags a consumed-but-never-produced artifact', () => {
    const stagesById = { b: stage('b', { inputs: [{ artifact: 'ghost', required: true }] }) };
    const graph = compileStageGraph([placement('b')], stagesById);
    expect(graph.danglingConsumes).toContainEqual({ stageId: 'b', artifact: 'ghost' });
  });

  it('flags a produced-but-never-consumed artifact (orphan warning)', () => {
    const stagesById = { a: stage('a', { outputs: ['unused'] }) };
    const graph = compileStageGraph([placement('a')], stagesById);
    expect(graph.orphanProduces).toContainEqual({ artifact: 'unused', producedBy: ['a'] });
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
});
