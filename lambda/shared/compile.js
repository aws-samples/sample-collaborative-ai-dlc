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
// A "stage block" here is the library Stage item (its flat V2 fields: produces,
// consumes, requires, blocksOn, sensors, reviewer, humanValidation), keyed by
// stageId.

const UNIT_FOR_EACH = 'unit-of-work';

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
// A stage's autonomy reflects three orthogonal verification axes (flat V2
// fields): the human gate (`humanValidation`), the LLM-judged `reviewer`, and
// deterministic `sensors`. A stage self-halts only when no axis forces a human
// in the loop: humanValidation not required AND no reviewer. A reviewer alone
// (READY/NOT-READY, may escalate) is `mixed`; a required human gate is
// `human-gated`. Deterministic sensors never block self-halting (they are
// advisory). See the Autonomy Profile table in the spec.
const stageAutonomy = (stage) => {
  const humanValidation = stage?.humanValidation ?? 'none';
  const hasReviewer = Boolean(stage?.reviewer);

  // The human gate is the strongest signal.
  if (humanValidation === 'required') return 'human-gated';
  // A reviewer (or a conditional gate) puts a non-deterministic judge in the
  // loop without an unconditional human stop → mixed.
  if (hasReviewer || humanValidation === 'conditional') return 'mixed';
  // No human gate, no reviewer — only (advisory) deterministic sensors remain.
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
const stageProduces = (stage) => stage?.produces ?? [];
const stageConsumes = (stage) =>
  (stage?.consumes ?? []).map((i) => (typeof i === 'object' ? i.artifact : i));
const stageRequires = (stage) => stage?.requires ?? [];
// V2's reserved `blocks_on`: a completion-only ordering edge (run after, but no
// data is read). Distinct from `requires` (data dependency) and from the
// produces→consumes data edges. Empty on every shipped stage today.
const stageBlocksOn = (stage) => stage?.blocksOn ?? [];

// `artifactsById` is the optional artifact registry (id → ARTIFACT block).
// When supplied, it lets us tell a deliberate terminal output (a registered
// artifact no stage consumes) apart from an unregistered name (a likely typo),
// and flag consumed/produced names that are absent from the vocabulary.
const compileStageGraph = (placements, stagesById, artifactsById = null) => {
  let sectionHint = 0;
  let inForEachSection = false;
  const nodes = placements.map((p) => {
    const stage = stagesById[p.stageId];
    const forEach = stage?.forEach ?? null;
    const branchSection = forEach === UNIT_FOR_EACH;
    if (branchSection && !inForEachSection) sectionHint += 1;
    inForEachSection = branchSection;
    return {
      stageId: p.stageId,
      phasePath: p.phasePath ?? null,
      order: p.order ?? 0,
      forEach,
      execution: stage?.execution ?? null,
      branch:
        forEach == null
          ? null
          : {
              forEach,
              supported: forEach === UNIT_FOR_EACH,
              section: forEach === UNIT_FOR_EACH ? sectionHint : null,
            },
      section: forEach === UNIT_FOR_EACH ? sectionHint : null,
    };
  });
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
    // blocks_on: completion-only ordering edge (no data read). Also constrains
    // run order, so it participates in cycle detection alongside requires.
    for (const dep of stageBlocksOn(stage)) {
      if (!placed.has(dep)) continue;
      edges.push({ from: dep, to: p.stageId, kind: 'blocks' });
      ensure(p.stageId).add(dep);
    }
  }

  // Produced-but-never-consumed. Each entry is tagged `terminal` from the
  // artifact registry: a terminal artifact (questions file, report, final
  // brief) is a deliberate end-of-flow output, not a wiring mistake — so the UI
  // can quiet it. A non-terminal orphan (or one absent from the registry) is the
  // genuine "produced but nothing reads it" warning. When no registry is
  // supplied, terminal is null (unknown) and every orphan reads as a warning.
  const allConsumed = new Set();
  for (const p of placements) {
    for (const a of stageConsumes(stagesById[p.stageId])) allConsumed.add(a);
  }
  const orphanProduces = [];
  for (const [artifact, from] of Object.entries(producers)) {
    if (!allConsumed.has(artifact)) {
      const terminal = artifactsById ? Boolean(artifactsById[artifact]?.terminal) : null;
      orphanProduces.push({ artifact, producedBy: from, terminal });
    }
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

// ── Rule resolution ──
// V2's resolution chain (org → team → team-learnings → project →
// project-learnings → phase → stage). The universal layers (org/team/project
// plus the two interleaved learnings tiers) apply to every stage; a
// `phase`-layer rule attaches to a placement when its rule's `phase` matches the
// stage's phase (pull authoring — the rule binds via the stage's existing phase
// declaration). Takes the workflow's ruleRefs, the rule library blocks they
// point at (keyed by id), and the stage blocks (for each placement's phase).
// Returns the priority-ordered universal layer stack, a per-stage applicable-rule
// list, the rule→sensor pairings, and flags refs that don't resolve.
const UNIVERSAL_LAYERS = ['org', 'team', 'team-learnings', 'project', 'project-learnings'];
// Resolved-order priority (mirrors blocks.js RULE_LAYER_PRIORITY); learnings
// tiers sort immediately after their parent tier.
const LAYER_PRIORITY = {
  org: 0,
  team: 1,
  'team-learnings': 1.5,
  project: 2,
  'project-learnings': 2.5,
  phase: 3,
  stage: 4,
};

const compileRules = (placements, ruleRefs, rulesById, stagesById) => {
  const resolved = ruleRefs.map((ref) => rulesById[ref.ruleId]).filter(Boolean);
  const unresolved = ruleRefs.filter((ref) => !rulesById[ref.ruleId]).map((ref) => ref.ruleId);

  const universal = resolved
    .filter((rule) => UNIVERSAL_LAYERS.includes(rule.layer))
    .map((rule) => ({ ruleId: rule.blockId ?? rule.id, layer: rule.layer }))
    .toSorted((a, b) => (LAYER_PRIORITY[a.layer] ?? 99) - (LAYER_PRIORITY[b.layer] ?? 99));

  // Phase rules indexed by the phase they attach to.
  const phaseRules = {};
  for (const rule of resolved) {
    if (rule.layer === 'phase' && rule.phase) {
      (phaseRules[rule.phase] ??= []).push(rule.blockId ?? rule.id);
    }
  }

  // rule → sensor pairings (the feedforward/feedback control-loop link). A
  // `feedforward-only` sentinel means the rule deliberately needs no sensor.
  const pairings = [];
  for (const rule of resolved) {
    if (rule.pairing) {
      pairings.push({ ruleId: rule.blockId ?? rule.id, sensor: rule.pairing });
    }
  }

  // Per stage: the universal layers (always) plus any phase rule matching the
  // stage's phase (the flat `phase` field).
  const perStage = {};
  for (const p of placements) {
    const stage = stagesById[p.stageId];
    const phase = stage?.phase ?? null;
    perStage[p.stageId] = {
      universal: universal.map((u) => u.ruleId),
      phase: phase && phaseRules[phase] ? [...phaseRules[phase]] : [],
    };
  }

  return { universal, phaseRules, pairings, perStage, unresolved };
};

const compileWorkflow = (
  placements,
  scopeSlugs,
  stagesById,
  artifactsById = null,
  ruleRefs = [],
  rulesById = {},
) => ({
  scopeGrid: compileScopeGrid(placements, scopeSlugs),
  autonomy: compileAutonomyProfile(placements, stagesById),
  graph: compileStageGraph(placements, stagesById, artifactsById),
  rules: compileRules(placements, ruleRefs, rulesById, stagesById),
});

export {
  compileScopeGrid,
  compileAutonomyProfile,
  compileStageGraph,
  compileRules,
  compileWorkflow,
  stageAutonomy,
};
export default {
  compileScopeGrid,
  compileAutonomyProfile,
  compileStageGraph,
  compileRules,
  compileWorkflow,
  stageAutonomy,
};
