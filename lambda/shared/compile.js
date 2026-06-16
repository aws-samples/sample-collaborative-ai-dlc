'use strict';

// Pure compilers for the per-workflow derived views. These take already-loaded
// data (placements, scope slugs, and the stage blocks the placements reference)
// and return plain objects — no I/O, so they are trivially testable and the
// same logic backs the API response and any future cache.
//
// Three views (spec 01-building-blocks.md):
//   - scope-grid:       { scope → { stageId → EXECUTE | SKIP } }
//   - autonomy-profile: per-stage autonomy + a workflow roll-up
//   - stage-graph:      placed-stage nodes + produces/consumes/requires edges,
//                       with cycle + orphan-artifact detection
//
// A "stage block" here is the library Stage item (its c1_definition,
// c2_verification, clarification), keyed by stageId.

// ── Scope grid ──
// Transpose placements' scopeMembership into { scope → { skill → state } }.
// Any scope not listed on a placement defaults to SKIP.
const compileScopeGrid = (placements, scopeSlugs) => {
  const grid = {};
  for (const scope of scopeSlugs) {
    grid[scope] = {};
    for (const p of placements) {
      grid[scope][p.stageId] = p.scopeMembership?.[scope] === 'EXECUTE' ? 'EXECUTE' : 'SKIP';
    }
  }
  return grid;
};

// ── Autonomy ──
// A stage self-halts only when BOTH gates are closed: no mandatory front-gate
// clarification AND all sensors deterministic (and humanValidation not
// required). See the Autonomy Profile table in the spec.
const stageAutonomy = (stage) => {
  const clarification = stage?.clarification?.required ?? 'none';
  const c2 = stage?.c2_verification ?? {};
  const sensors = c2.sensors ?? c2.postConditions ?? [];
  const humanValidation = c2.humanValidation ?? 'none';

  // Front gate.
  if (clarification === 'always') return 'human-gated';
  // Back gate: an explicit required validation, or any llm-judged check.
  if (humanValidation === 'required') return 'human-gated';

  const modes = sensors.map((s) => (typeof s === 'object' ? s.mode : s?.mode));
  const hasLlm = modes.includes('llm-judged');
  const hasDeterministic = modes.includes('deterministic');

  if (hasLlm && !hasDeterministic) return 'human-gated';
  if (hasLlm || clarification === 'conditional' || humanValidation === 'conditional') {
    return 'mixed';
  }
  // Both gates closed.
  return 'self-halting';
};

const compileAutonomyProfile = (placements, stagesById) => {
  const perStage = {};
  const rollup = { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 };
  for (const p of placements) {
    const level = stageAutonomy(stagesById[p.stageId]);
    perStage[p.stageId] = level;
    rollup.total += 1;
    if (level === 'self-halting') rollup.selfHalting += 1;
    else if (level === 'mixed') rollup.mixed += 1;
    else rollup.humanGated += 1;
  }
  return { perStage, rollup };
};

// ── Stage graph ──
// Nodes = placed stages; edges = produces→consumes (data) and requires
// (ordering). Detects cycles and orphan artifacts.
const stageProduces = (stage) => {
  const c1 = stage?.c1_definition ?? {};
  return [...(c1.outputs ?? []), ...(c1.intermediates ?? [])];
};
const stageConsumes = (stage) =>
  (stage?.c1_definition?.inputs ?? []).map((i) => (typeof i === 'object' ? i.artifact : i));
const stageRequires = (stage) => stage?.c1_definition?.requires ?? [];

// `artifactsById` is the optional artifact registry (id → ARTIFACT block).
// When supplied, it lets us tell a deliberate terminal output (a registered
// artifact no stage consumes) apart from an unregistered name (a likely typo),
// and flag consumed/produced names that are absent from the vocabulary.
const compileStageGraph = (placements, stagesById, artifactsById = null) => {
  const nodes = placements.map((p) => ({
    stageId: p.stageId,
    phasePath: p.phasePath ?? null,
    order: p.order ?? 0,
  }));
  const placed = new Set(placements.map((p) => p.stageId));

  // Producer map: artifact → [stageId].
  const producers = {};
  for (const p of placements) {
    for (const artifact of stageProduces(stagesById[p.stageId])) {
      (producers[artifact] ??= []).push(p.stageId);
    }
  }

  const edges = [];
  const adjacency = {}; // stageId → Set(dependency stageId) for cycle detection
  const ensure = (id) => (adjacency[id] ??= new Set());

  const danglingConsumes = []; // { stageId, artifact } consumed but never produced
  for (const p of placements) {
    const stage = stagesById[p.stageId];
    ensure(p.stageId);
    for (const artifact of stageConsumes(stage)) {
      const from = producers[artifact];
      if (!from || from.length === 0) {
        danglingConsumes.push({ stageId: p.stageId, artifact });
        continue;
      }
      for (const producer of from) {
        if (producer === p.stageId) continue;
        edges.push({ from: producer, to: p.stageId, artifact, kind: 'data' });
        ensure(p.stageId).add(producer);
      }
    }
    // requires: ordering-only edges (stage must run after the required stage).
    for (const req of stageRequires(stage)) {
      if (!placed.has(req)) continue;
      edges.push({ from: req, to: p.stageId, kind: 'requires' });
      ensure(p.stageId).add(req);
    }
  }

  // Produced-but-never-consumed (warning, not error).
  const allConsumed = new Set();
  for (const p of placements) {
    for (const a of stageConsumes(stagesById[p.stageId])) allConsumed.add(a);
  }
  const orphanProduces = [];
  for (const [artifact, from] of Object.entries(producers)) {
    if (!allConsumed.has(artifact)) orphanProduces.push({ artifact, producedBy: from });
  }

  const cycles = detectCycle(adjacency);

  // Registry cross-check (only when an artifact vocabulary is supplied): any
  // produced or consumed name with no ARTIFACT block is unknown vocabulary —
  // the typo case that orphanProduces alone can't distinguish from a genuine
  // terminal output. A terminal output is one that IS registered but unconsumed.
  const unknownArtifacts = [];
  if (artifactsById) {
    const seen = new Set();
    const flagUnknown = (name, stageId, role) => {
      if (artifactsById[name]) return;
      const key = `${name}|${stageId}|${role}`;
      if (seen.has(key)) return;
      seen.add(key);
      unknownArtifacts.push({ artifact: name, stageId, role });
    };
    for (const p of placements) {
      const stage = stagesById[p.stageId];
      for (const a of stageProduces(stage)) flagUnknown(a, p.stageId, 'produces');
      for (const a of stageConsumes(stage)) flagUnknown(a, p.stageId, 'consumes');
    }
  }

  return {
    nodes,
    edges,
    cycles,
    danglingConsumes,
    orphanProduces,
    unknownArtifacts,
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

const compileWorkflow = (placements, scopeSlugs, stagesById, artifactsById = null) => ({
  scopeGrid: compileScopeGrid(placements, scopeSlugs),
  autonomy: compileAutonomyProfile(placements, stagesById),
  graph: compileStageGraph(placements, stagesById, artifactsById),
});

module.exports = {
  compileScopeGrid,
  compileAutonomyProfile,
  compileStageGraph,
  compileWorkflow,
  stageAutonomy,
};
