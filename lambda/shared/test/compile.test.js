import { describe, it, expect } from 'vitest';
import {
  compileScopeGrid,
  compileAutonomyProfile,
  compileSkillGraph,
  skillAutonomy,
} from '../compile.js';

// A library Skill block, minimally shaped for the compilers.
const skill = (
  id,
  { clarification, postConditions, humanValidation, inputs, outputs, requires } = {},
) => ({
  blockId: id,
  clarification: clarification ? { required: clarification } : undefined,
  c2_verification: {
    postConditions: postConditions ?? [],
    humanValidation: humanValidation ?? 'none',
  },
  c1_definition: {
    inputs: inputs ?? [],
    outputs: outputs ?? [],
    intermediates: [],
    requires: requires ?? [],
  },
});

const placement = (skillId, scopeMembership = {}, extra = {}) => ({
  skillId,
  groupingPath: extra.groupingPath ?? null,
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

describe('skillAutonomy — both gates', () => {
  it('self-halting: no clarification, all deterministic', () => {
    expect(skillAutonomy(skill('s', { postConditions: [{ mode: 'deterministic' }] }))).toBe(
      'self-halting',
    );
  });

  it('self-halting: no gates at all', () => {
    expect(skillAutonomy(skill('s'))).toBe('self-halting');
  });

  it('human-gated: front gate open (clarification always)', () => {
    expect(
      skillAutonomy(
        skill('s', { clarification: 'always', postConditions: [{ mode: 'deterministic' }] }),
      ),
    ).toBe('human-gated');
  });

  it('human-gated: humanValidation required', () => {
    expect(skillAutonomy(skill('s', { humanValidation: 'required' }))).toBe('human-gated');
  });

  it('human-gated: only llm-judged post-conditions', () => {
    expect(skillAutonomy(skill('s', { postConditions: [{ mode: 'llm-judged' }] }))).toBe(
      'human-gated',
    );
  });

  it('mixed: both deterministic and llm-judged', () => {
    expect(
      skillAutonomy(
        skill('s', { postConditions: [{ mode: 'deterministic' }, { mode: 'llm-judged' }] }),
      ),
    ).toBe('mixed');
  });

  it('mixed: conditional clarification with deterministic checks', () => {
    expect(
      skillAutonomy(
        skill('s', { clarification: 'conditional', postConditions: [{ mode: 'deterministic' }] }),
      ),
    ).toBe('mixed');
  });
});

describe('compileAutonomyProfile', () => {
  it('rolls up per-skill levels', () => {
    const skillsById = {
      a: skill('a', { postConditions: [{ mode: 'deterministic' }] }), // self-halting
      b: skill('b', { postConditions: [{ mode: 'llm-judged' }] }), // human-gated
      c: skill('c', { postConditions: [{ mode: 'deterministic' }, { mode: 'llm-judged' }] }), // mixed
    };
    const { perSkill, rollup } = compileAutonomyProfile(
      [placement('a'), placement('b'), placement('c')],
      skillsById,
    );
    expect(perSkill).toEqual({ a: 'self-halting', b: 'human-gated', c: 'mixed' });
    expect(rollup).toEqual({ selfHalting: 1, mixed: 1, humanGated: 1, total: 3 });
  });
});

describe('compileSkillGraph', () => {
  it('wires produces→consumes edges', () => {
    const skillsById = {
      a: skill('a', { outputs: ['doc'] }),
      b: skill('b', { inputs: [{ artifact: 'doc', required: true }] }),
    };
    const graph = compileSkillGraph([placement('a'), placement('b')], skillsById);
    expect(graph.acyclic).toBe(true);
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b', artifact: 'doc', kind: 'data' });
    expect(graph.danglingConsumes).toEqual([]);
  });

  it('flags a consumed-but-never-produced artifact', () => {
    const skillsById = { b: skill('b', { inputs: [{ artifact: 'ghost', required: true }] }) };
    const graph = compileSkillGraph([placement('b')], skillsById);
    expect(graph.danglingConsumes).toContainEqual({ skillId: 'b', artifact: 'ghost' });
  });

  it('flags a produced-but-never-consumed artifact (orphan warning)', () => {
    const skillsById = { a: skill('a', { outputs: ['unused'] }) };
    const graph = compileSkillGraph([placement('a')], skillsById);
    expect(graph.orphanProduces).toContainEqual({ artifact: 'unused', producedBy: ['a'] });
  });

  it('detects a cycle via produces/consumes', () => {
    const skillsById = {
      a: skill('a', { outputs: ['x'], inputs: [{ artifact: 'y' }] }),
      b: skill('b', { outputs: ['y'], inputs: [{ artifact: 'x' }] }),
    };
    const graph = compileSkillGraph([placement('a'), placement('b')], skillsById);
    expect(graph.acyclic).toBe(false);
    expect(graph.cycles.toSorted()).toEqual(['a', 'b']);
  });

  it('adds requires ordering edges only for placed skills', () => {
    const skillsById = {
      a: skill('a'),
      b: skill('b', { requires: ['a', 'not-placed'] }),
    };
    const graph = compileSkillGraph([placement('a'), placement('b')], skillsById);
    expect(graph.edges).toContainEqual({ from: 'a', to: 'b', kind: 'requires' });
    expect(graph.edges.filter((e) => e.from === 'not-placed')).toEqual([]);
  });
});
