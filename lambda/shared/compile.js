'use strict';

// Pure compilers for the per-workflow derived views. These take already-loaded
// data (placements, scope slugs, and the skill blocks the placements reference)
// and return plain objects — no I/O, so they are trivially testable and the
// same logic backs the API response and any future cache.
//
// Three views (spec 01-building-blocks.md):
//   - scope-grid:       { scope → { skillId → EXECUTE | SKIP } }
//   - autonomy-profile: per-skill autonomy + a workflow roll-up
//   - skill-graph:      placed-skill nodes + produces/consumes/requires edges,
//                       with cycle + orphan-artifact detection
//
// A "skill block" here is the library Skill item (its c1_definition,
// c2_verification, clarification), keyed by skillId.

// ── Scope grid ──
// Transpose placements' scopeMembership into { scope → { skill → state } }.
// Any scope not listed on a placement defaults to SKIP.
const compileScopeGrid = (placements, scopeSlugs) => {
  const grid = {};
  for (const scope of scopeSlugs) {
    grid[scope] = {};
    for (const p of placements) {
      grid[scope][p.skillId] = p.scopeMembership?.[scope] === 'EXECUTE' ? 'EXECUTE' : 'SKIP';
    }
  }
  return grid;
};

// ── Autonomy ──
// A skill self-halts only when BOTH gates are closed: no mandatory front-gate
// clarification AND all post-conditions deterministic (and humanValidation not
// required). See the Autonomy Profile table in the spec.
const skillAutonomy = (skill) => {
  const clarification = skill?.clarification?.required ?? 'none';
  const c2 = skill?.c2_verification ?? {};
  const postConditions = c2.postConditions ?? [];
  const humanValidation = c2.humanValidation ?? 'none';

  // Front gate.
  if (clarification === 'always') return 'human-gated';
  // Back gate: an explicit required validation, or any llm-judged check.
  if (humanValidation === 'required') return 'human-gated';

  const modes = postConditions.map((pc) => (typeof pc === 'object' ? pc.mode : pc?.mode));
  const hasLlm = modes.includes('llm-judged');
  const hasDeterministic = modes.includes('deterministic');

  if (hasLlm && !hasDeterministic) return 'human-gated';
  if (hasLlm || clarification === 'conditional' || humanValidation === 'conditional') {
    return 'mixed';
  }
  // Both gates closed.
  return 'self-halting';
};

const compileAutonomyProfile = (placements, skillsById) => {
  const perSkill = {};
  const rollup = { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 };
  for (const p of placements) {
    const level = skillAutonomy(skillsById[p.skillId]);
    perSkill[p.skillId] = level;
    rollup.total += 1;
    if (level === 'self-halting') rollup.selfHalting += 1;
    else if (level === 'mixed') rollup.mixed += 1;
    else rollup.humanGated += 1;
  }
  return { perSkill, rollup };
};

// ── Skill graph ──
// Nodes = placed skills; edges = produces→consumes (data) and requires
// (ordering). Detects cycles and orphan artifacts.
const skillProduces = (skill) => {
  const c1 = skill?.c1_definition ?? {};
  return [...(c1.outputs ?? []), ...(c1.intermediates ?? [])];
};
const skillConsumes = (skill) =>
  (skill?.c1_definition?.inputs ?? []).map((i) => (typeof i === 'object' ? i.artifact : i));
const skillRequires = (skill) => skill?.c1_definition?.requires ?? [];

const compileSkillGraph = (placements, skillsById) => {
  const nodes = placements.map((p) => ({
    skillId: p.skillId,
    groupingPath: p.groupingPath ?? null,
    order: p.order ?? 0,
  }));
  const placed = new Set(placements.map((p) => p.skillId));

  // Producer map: artifact → [skillId].
  const producers = {};
  for (const p of placements) {
    for (const artifact of skillProduces(skillsById[p.skillId])) {
      (producers[artifact] ??= []).push(p.skillId);
    }
  }

  const edges = [];
  const adjacency = {}; // skillId → Set(dependency skillId) for cycle detection
  const ensure = (id) => (adjacency[id] ??= new Set());

  const danglingConsumes = []; // { skillId, artifact } consumed but never produced
  for (const p of placements) {
    const skill = skillsById[p.skillId];
    ensure(p.skillId);
    for (const artifact of skillConsumes(skill)) {
      const from = producers[artifact];
      if (!from || from.length === 0) {
        danglingConsumes.push({ skillId: p.skillId, artifact });
        continue;
      }
      for (const producer of from) {
        if (producer === p.skillId) continue;
        edges.push({ from: producer, to: p.skillId, artifact, kind: 'data' });
        ensure(p.skillId).add(producer);
      }
    }
    // requires: ordering-only edges (skill must run after the required skill).
    for (const req of skillRequires(skill)) {
      if (!placed.has(req)) continue;
      edges.push({ from: req, to: p.skillId, kind: 'requires' });
      ensure(p.skillId).add(req);
    }
  }

  // Produced-but-never-consumed (warning, not error).
  const allConsumed = new Set();
  for (const p of placements) {
    for (const a of skillConsumes(skillsById[p.skillId])) allConsumed.add(a);
  }
  const orphanProduces = [];
  for (const [artifact, from] of Object.entries(producers)) {
    if (!allConsumed.has(artifact)) orphanProduces.push({ artifact, producedBy: from });
  }

  const cycles = detectCycle(adjacency);

  return {
    nodes,
    edges,
    cycles,
    danglingConsumes,
    orphanProduces,
    acyclic: cycles.length === 0,
  };
};

// DFS cycle detection over the dependency adjacency. Returns the skill ids
// involved in the first cycle found (empty when acyclic).
const detectCycle = (adjacency) => {
  const WHITE = 0;
  const GREY = 1;
  const BLACK = 2;
  const color = {};
  const stack = [];
  let found = [];

  const visit = (node) => {
    color[node] = GREY;
    stack.push(node);
    for (const dep of adjacency[node] ?? []) {
      if (color[dep] === GREY) {
        // Back edge → cycle. Capture from dep to current.
        const idx = stack.indexOf(dep);
        found = stack.slice(idx);
        return true;
      }
      if ((color[dep] ?? WHITE) === WHITE && visit(dep)) return true;
    }
    stack.pop();
    color[node] = BLACK;
    return false;
  };

  for (const node of Object.keys(adjacency)) {
    if ((color[node] ?? WHITE) === WHITE && visit(node)) break;
  }
  return found;
};

const compileWorkflow = (placements, scopeSlugs, skillsById) => ({
  scopeGrid: compileScopeGrid(placements, scopeSlugs),
  autonomy: compileAutonomyProfile(placements, skillsById),
  graph: compileSkillGraph(placements, skillsById),
});

module.exports = {
  compileScopeGrid,
  compileAutonomyProfile,
  compileSkillGraph,
  compileWorkflow,
  skillAutonomy,
};
