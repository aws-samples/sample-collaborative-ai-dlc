'use strict';

// V2 runnable-plan resolver — turns a pinned workflow version + a selected scope
// into an immutable, validated, runnable execution plan.
//
// This is the seam between AUTHORING (the block library + `compile.js`'s derived
// views, which are editor-facing) and RUNTIME (the AgentCore container that
// executes one stage at a time). `compile.js` answers "what does this workflow
// look like in the editor"; this module answers "is this workflow runnable for
// this scope, and what is the ordered list of stage instances to run".
//
// It is a PURE function — no DynamoDB, S3, Neptune, or network. The caller (the
// container's init path, or a future trigger lambda) loads the workflow + the
// referenced library blocks, calls this, and MUST check `valid` before using
// `plan`. Errors are returned as structured objects, never thrown.
//
// It reuses `compileStageGraph` / `compileRules` from compile.js over the
// IN-SCOPE placement subset (SKIP stages never enter the plan), so cycle and
// dangling-consume detection have a single source of truth.
//
// NOTE — model: this reads the flat-frontmatter stage shape
// (produces/consumes/sensors/reviewer/humanValidation); see `block-mappers.js`
// `mapStage` for the seeded shape it consumes.

const { createHash } = require('node:crypto');
const { compileStageGraph, compileRules } = require('./compile.js');

// Stage modes the runtime can actually execute. `agent-team` is known but not
// runnable yet: a stage that declares it is flagged `notImplemented` so it fails
// fast at run time instead of crashing the resolver.
const RUNNABLE_MODES = ['inline', 'subagent'];

// Reserved lead-agent refs that are NOT domain AGENT blocks and therefore have no
// library entry to resolve against. Upstream's initialization stages declare
// `lead_agent: orchestrator`, where "orchestrator" is the conductor / forwarding
// loop itself (its persona is conductor.md, not an AGENT file). Treat it as a
// built-in: skip the unresolved-agent check, and the runtime runs the stage with
// no injected persona (the conductor IS the default voice).
const RESERVED_AGENT_REFS = new Set(['orchestrator']);

// The only fan-out grain the engine schedules (docs/v2-parallel.md A2): a stage
// marked `forEach: unit-of-work` runs once per unit of the execution's unit DAG,
// which an upstream in-scope stage must produce as this artifact. Any OTHER
// forEach value is authorable upstream but not schedulable here — the plan
// fails loudly (`unsupported_for_each`) instead of silently running the stage
// once (which would break the stage's own contract).
const UNIT_FOR_EACH = 'unit-of-work';
const UNIT_DAG_ARTIFACT = 'unit-of-work-dependency';

// Every validation failure is a plain object (never thrown) so the caller can
// surface all reasons at once and reject cleanly. Warnings share the shape:
// non-fatal, informational, returned alongside `errors` without affecting
// `valid` (the "required when in scope" pattern — see the dangling-consume
// classification below).
const err = (code, message, extra = {}) => ({ code, message, ...extra });

// Deterministic stage-instance id: stable for a given (namespace, stageId), with
// no time/random input, so the same execution re-resolves to identical ids
// (re-entrancy + reproducible tests). The execution id namespaces instances;
// absent one (a dry plan), the immutable workflow pin is the namespace.
// A `forEach: unit-of-work` stage gains the unit dimension: one instance per
// unit slug (`namespace:stageId:unit-<slug>`), equally deterministic so lanes
// re-resolve to identical ids across replays (docs/v2-parallel.md A2 rule 3).
const stageInstanceId = (namespace, stageId, unitSlug = null) =>
  `si-${createHash('sha256')
    .update(unitSlug ? `${namespace}:${stageId}:unit-${unitSlug}` : `${namespace}:${stageId}`)
    .digest('hex')
    .slice(0, 16)}`;

// The scopes a workflow offers. Prefer explicit scope refs; fall back to the
// union of every placement's scopeMembership keys (the seeded default workflow
// puts membership on placements without separate scope-ref rows).
const workflowScopes = (workflow) => {
  const refs = (workflow.scopeRefs ?? []).map((r) => r.scopeId).filter(Boolean);
  if (refs.length > 0) return new Set(refs);
  const fromMembership = new Set();
  for (const p of workflow.placements ?? []) {
    for (const key of Object.keys(p.scopeMembership ?? {})) fromMembership.add(key);
  }
  return fromMembership;
};

// A placement is in scope when its membership for the selected scope is EXECUTE.
const isInScope = (placement, scope) => placement.scopeMembership?.[scope] === 'EXECUTE';

// Normalize a stage's consume edges to { artifact, required, conditionalOn }.
// The mapper already emits this shape; tolerate a bare string for safety.
const stageInputs = (stage) =>
  (stage?.consumes ?? []).map((c) =>
    typeof c === 'object'
      ? {
          artifact: c.artifact,
          required: c.required !== false,
          conditionalOn: c.conditionalOn ?? null,
        }
      : { artifact: c, required: true, conditionalOn: null },
  );

// Resolve + validate the deterministic sensors a stage runs. The reviewer is a
// SEPARATE axis (stage.reviewer), handled below — it is NOT a sensor here.
const resolveSensors = (stage, stageId, sensorsById, errors) =>
  (stage?.sensors ?? [])
    .map((sid) => {
      const sensor = sensorsById[sid];
      if (!sensor) {
        errors.push(
          err('unresolved_sensor', `stage "${stageId}" references unknown sensor "${sid}"`, {
            stageId,
            ref: sid,
          }),
        );
        return null;
      }
      // Current model: sensors are deterministic-only (the llm-judged half is the
      // stage reviewer). A sensor needs a runnable command.
      if (typeof sensor.command !== 'string' || !sensor.command) {
        errors.push(
          err('sensor_missing_command', `sensor "${sid}" has no command`, { stageId, ref: sid }),
        );
      }
      return {
        sensorId: sid,
        severity: sensor.severity ?? 'advisory',
        runtime: sensor.runtime ?? 'bun',
        command: sensor.command ?? null,
        timeoutSeconds: sensor.timeoutSeconds ?? null,
        category: sensor.category ?? null,
        matches: sensor.matches ?? null,
      };
    })
    .filter(Boolean);

// Resolve the reviewer axis (the clean-room LLM judge). Returns null when the
// stage declares none. A declared reviewer must resolve to an AGENT block and
// carry a positive iteration budget.
const resolveReviewer = (stage, stageId, agentsById, errors) => {
  if (!stage?.reviewer) return null;
  if (!agentsById[stage.reviewer]) {
    errors.push(
      err('unresolved_agent', `stage "${stageId}" reviewer "${stage.reviewer}" does not resolve`, {
        stageId,
        ref: stage.reviewer,
      }),
    );
  }
  const max = stage.reviewerMaxIterations;
  if (max != null && (!Number.isInteger(max) || max < 1)) {
    errors.push(
      err(
        'reviewer_bad_iterations',
        `stage "${stageId}" reviewerMaxIterations must be a positive integer`,
        { stageId },
      ),
    );
  }
  return { reviewerAgent: stage.reviewer, maxIterations: max ?? 1 };
};

// Linearize resolved plan stages so every stage follows the ones it depends on.
// Kahn's algorithm over `dependencyStageIds` (the union of data/requires/blocksOn
// edges resolved for the in-scope subset), with the authored `order` (then
// stageId) as a deterministic tiebreak among ready stages — keeping the sequence
// as close to the authored order as the dependencies permit. Dependencies on
// stages outside this set (e.g. filtered out of scope) are ignored so they can't
// stall the sort. A cycle leaves stages unemitted; they are appended in tiebreak
// order (the resolver has already flagged the cycle as invalid).
const runOrderTiebreak = (a, b) => a.order - b.order || a.stageId.localeCompare(b.stageId);
const topologicalRunOrder = (stages) => {
  const tiebreak = runOrderTiebreak;
  const present = new Set(stages.map((s) => s.stageId));
  const deps = new Map(
    stages.map((s) => [s.stageId, (s.dependencyStageIds ?? []).filter((d) => present.has(d))]),
  );
  const remaining = new Set(stages.map((s) => s.stageId));
  const emitted = new Set();
  const byId = new Map(stages.map((s) => [s.stageId, s]));
  const ordered = [];
  while (remaining.size > 0) {
    const ready = [...remaining]
      .filter((id) => deps.get(id).every((d) => emitted.has(d)))
      .map((id) => byId.get(id))
      .toSorted(tiebreak);
    if (ready.length === 0) break; // cycle — append remainder below
    const next = ready[0];
    ordered.push(next);
    emitted.add(next.stageId);
    remaining.delete(next.stageId);
  }
  const leftover = [...remaining].map((id) => byId.get(id)).toSorted(tiebreak);
  return [...ordered, ...leftover];
};

// `library` is the resolved block bag: { stagesById, agentsById, sensorsById,
// rulesById, artifactsById }. `compiled` (optional) is a prior compileWorkflow
// output whose per-stage rules we can reuse; the dependency graph is always
// recomputed over the IN-SCOPE subset.
const buildExecutionPlan = ({
  workflow,
  scope,
  settings = {},
  library = {},
  compiled = null,
} = {}) => {
  const errors = [];
  const warnings = [];
  const {
    stagesById = {},
    agentsById = {},
    sensorsById = {},
    rulesById = {},
    artifactsById = {},
  } = library;

  if (!workflow || typeof workflow !== 'object') {
    return {
      valid: false,
      errors: [err('workflow_missing', 'workflow composition is required')],
      warnings,
      plan: null,
    };
  }

  const workflowId = workflow.workflowId ?? workflow.id ?? null;
  const workflowVersion = workflow.workflowVersion ?? workflow.version ?? null;

  // A runnable plan must pin to an immutable, numbered workflow version — never
  // a mutable "latest". A positive integer is the pin.
  if (!Number.isInteger(workflowVersion) || workflowVersion < 1) {
    errors.push(
      err('workflow_version_missing', 'workflow must pin an immutable positive-integer version'),
    );
  }

  // The selected scope must be one the workflow actually offers.
  const scopes = workflowScopes(workflow);
  if (!scope || !scopes.has(scope)) {
    errors.push(
      err('scope_not_found', `scope "${scope}" is not defined in workflow "${workflowId}"`, {
        ref: scope,
      }),
    );
    // Without a resolvable scope there is nothing meaningful to build.
    return { valid: false, errors, warnings, plan: null };
  }

  // Project the workflow onto the scope: only EXECUTE placements become stage
  // instances. Cycle/dangling analysis runs over this subset, not the whole
  // authored workflow.
  const placements = (workflow.placements ?? []).filter((p) => isInScope(p, scope));
  const inScopeIds = new Set(placements.map((p) => p.stageId));

  // A placement wired to EXECUTE in NO scope can never run in ANY run of this
  // workflow — almost always an authoring accident (the composer used to store
  // scopeMembership {} on add; field incident: reverse-engineering silently
  // un-wired for every scope). Non-fatal: an intentionally parked stage stays
  // legal, but the advisory reaches the timeline via the warnings pipeline.
  for (const p of workflow.placements ?? []) {
    const wired = Object.values(p.scopeMembership ?? {}).some((v) => v === 'EXECUTE');
    if (!wired) {
      warnings.push(
        err(
          'zero_scope_placement',
          `stage "${p.stageId}" is not wired to EXECUTE in any scope — it will never run in this workflow`,
          { stageId: p.stageId, ref: p.stageId },
        ),
      );
    }
  }

  // Scope-agnostic producer map over the WHOLE authored workflow (every
  // placement, any scope). This is what tells a deliberate scope shortcut
  // (producer exists, but is SKIP for this scope — upstream's documented
  // "required when in scope" semantics) apart from a genuine authoring bug
  // (no stage anywhere produces the artifact — a typo / missing placement).
  const workflowProducers = new Set();
  for (const p of workflow.placements ?? []) {
    for (const artifact of stagesById[p.stageId]?.produces ?? []) {
      workflowProducers.add(artifact);
    }
  }

  // Reuse the authoring graph compiler over the in-scope subset (single source
  // of truth for cycle + dangling detection).
  const graph = compileStageGraph(placements, stagesById, artifactsById);
  if (!graph.acyclic) {
    errors.push(
      err('graph_cycle', `stage dependency cycle: ${graph.cycles.join(' → ')}`, {
        ref: graph.cycles,
      }),
    );
  }

  // A dangling consume (consumed but produced by no in-scope stage) follows the
  // "required when in scope" pattern (upstream stage-definition.md: required
  // means "if the producing stage runs, this consume must be satisfied", never
  // a global existence assertion). Classification:
  //   - optional (required:false) or gated (conditionalOn) → allowed, silent.
  //   - required + unconditional, but SOME stage in the authored workflow
  //     produces it (just not in this scope) → the designed scope-shortcut:
  //     non-fatal `scope_absent_consume` warning; the input is annotated
  //     `expectedAbsent` below so the prompt/sensors treat it as by-design.
  //   - required + unconditional, produced NOWHERE in the workflow → a genuine
  //     authoring bug (typo / missing placement): fatal `dangling_consume`.
  const expectedAbsentByStage = new Map(); // stageId → Set(artifact)
  for (const { stageId, artifact } of graph.danglingConsumes) {
    const input = stageInputs(stagesById[stageId]).find((i) => i.artifact === artifact);
    const allowed = input && (input.required === false || input.conditionalOn != null);
    if (allowed) continue;
    if (workflowProducers.has(artifact)) {
      warnings.push(
        err(
          'scope_absent_consume',
          `stage "${stageId}" consumes "${artifact}", whose producer is not in scope "${scope}" — expected absent (scope shortcut)`,
          { stageId, ref: artifact },
        ),
      );
      if (!expectedAbsentByStage.has(stageId)) expectedAbsentByStage.set(stageId, new Set());
      expectedAbsentByStage.get(stageId).add(artifact);
    } else {
      errors.push(
        err(
          'dangling_consume',
          `stage "${stageId}" consumes "${artifact}", which no stage in the workflow produces`,
          { stageId, ref: artifact },
        ),
      );
    }
  }

  // Per-stage rule resolution: reuse the compiled view when supplied, else run
  // the authoring rule compiler over the in-scope placements.
  const rulesView =
    compiled?.rules ?? compileRules(placements, workflow.ruleRefs ?? [], rulesById, stagesById);

  // Namespace for deterministic instance ids: the execution when known, else the
  // immutable workflow pin.
  const namespace = settings.executionId ?? `${workflowId}@${workflowVersion}`;

  const stages = placements
    .map((placement) => {
      const stageId = placement.stageId;
      const stage = stagesById[stageId];
      if (!stage) {
        errors.push(
          err('unresolved_stage', `placement "${stageId}" does not resolve to a stage block`, {
            stageId,
            ref: stageId,
          }),
        );
        return null;
      }
      const stageVersion = stage.version ?? null;
      if (stageVersion == null) {
        errors.push(
          err('unresolved_stage', `stage "${stageId}" resolves to no block version`, {
            stageId,
            ref: stageId,
          }),
        );
      }

      // Lead + support agents must resolve — except reserved built-in refs
      // (e.g. "orchestrator" = the conductor itself, which has no AGENT block).
      const agentRef = stage.leadAgent ?? null;
      const supportAgentRefs = stage.supportAgents ?? [];
      for (const ref of [agentRef, ...supportAgentRefs].filter(Boolean)) {
        if (!RESERVED_AGENT_REFS.has(ref) && !agentsById[ref]) {
          errors.push(
            err('unresolved_agent', `stage "${stageId}" references unknown agent "${ref}"`, {
              stageId,
              ref,
            }),
          );
        }
      }

      const sensors = resolveSensors(stage, stageId, sensorsById, errors);
      const reviewer = resolveReviewer(stage, stageId, agentsById, errors);

      // Dependencies: every in-scope stage that must run before this one — the
      // union of data producers, `requires`, and `blocksOn`, read off the
      // in-scope graph edges (which already exclude out-of-scope stages).
      const dependencyStageIds = [
        ...new Set(graph.edges.filter((e) => e.to === stageId).map((e) => e.from)),
      ].filter((id) => inScopeIds.has(id));

      // Input artifacts, annotated with the in-scope stages that produce each.
      // `expectedAbsent` marks a required input whose producer exists in the
      // workflow but is out of scope (the scope-shortcut warning above): the
      // artifact will NOT exist at runtime and downstream consumers (prompt
      // rendering, sensors) must treat its absence as by-design, never invent
      // it. Mirrors upstream PR #482's `consumes_absent` / `expected: true`.
      const inputArtifacts = stageInputs(stage).map((i) => ({
        artifact: i.artifact,
        required: i.required,
        conditionalOn: i.conditionalOn,
        ...(expectedAbsentByStage.get(stageId)?.has(i.artifact) ? { expectedAbsent: true } : {}),
        producedBy: [
          ...new Set(
            graph.edges
              .filter((e) => e.kind === 'data' && e.to === stageId && e.artifact === i.artifact)
              .map((e) => e.from),
          ),
        ],
      }));

      const outputArtifacts = (stage.produces ?? []).map((artifact) => ({
        artifact,
        terminal: artifactsById[artifact] ? Boolean(artifactsById[artifact].terminal) : null,
      }));

      const instance = {
        stageInstanceId: stageInstanceId(namespace, stageId),
        stageId,
        stageVersion,
        phase: stage.phase ?? null,
        order: placement.order ?? 0,
        mode: stage.mode ?? 'inline',
        agentRef,
        supportAgentRefs,
        dependencyStageIds,
        inputArtifacts,
        outputArtifacts,
        rules: rulesView.perStage?.[stageId] ?? { universal: [], phase: [] },
        sensors,
        reviewer,
        // V2 gates every non-initialization stage on human approval; the mapper
        // already encodes this as the flat humanValidation field.
        humanValidation: stage.humanValidation ?? 'none',
        // Fan-out marker (upstream `for_each`) + execution policy (ALWAYS /
        // CONDITIONAL — per-unit skippability, docs/v2-parallel.md A2 rule 7).
        // `parallelSection` is stamped after the topological sort below.
        // `forEachDegraded` flips true when the stage's section is degraded to
        // once-per-workflow because the unit-DAG producer is out of scope.
        forEach: stage.forEach ?? null,
        execution: stage.execution ?? null,
        parallelSection: null,
        forEachDegraded: false,
      };

      // `agent-team` is a known-but-unrunnable mode. Flag, don't crash.
      if (!RUNNABLE_MODES.includes(instance.mode)) {
        instance.notImplemented = true;
        instance.runtimeError = 'not_implemented';
      }
      return instance;
    })
    .filter(Boolean);

  // Final run order is a dependency-respecting linearization, NOT raw `order`.
  // The orchestrator executes stages in this exact sequence with no run-time
  // re-sort, so a stage must never precede one it depends on. The seed builds a
  // topological `order` for the default workflow, but a forked/edited workflow
  // can carry a hand-authored `order` that violates its dependency edges — this
  // is the last gate before execution, so we enforce the invariant here for
  // EVERY workflow. `dependencyStageIds` (already resolved above from the
  // in-scope graph: data producers + requires + blocksOn) are the edges; the
  // authored `order` (then stageId) is the tiebreak among ready stages, so the
  // linearization stays as close to the authored intent as the dependencies
  // allow. A cycle (already flagged `graph_cycle` above) leaves stages stuck;
  // we append them in tiebreak order so the plan document is still complete.
  const orderedStages = topologicalRunOrder(stages);

  // ── Parallel sections (docs/v2-parallel.md A2) ────────────────────────────
  // A section is a maximal contiguous run (w.r.t. the topological run order
  // above) of `forEach: unit-of-work` stages. Sections are 1-based (`s<k>` in
  // branch/session naming). Detection is purely structural — no stage names —
  // so forked workflows get identical semantics. Two validations:
  //   unsupported_for_each — a forEach value the engine cannot schedule; fail
  //     loudly rather than run the stage once and break its own contract.
  //   no_unit_dag_producer — every section needs an in-scope stage EARLIER in
  //     the run order producing `unit-of-work-dependency` (the scheduling
  //     truth); mirrors upstream's Doctor rule, same style as dangling_consume.
  //     Like dangling_consume, this follows the "required when in scope"
  //     split: a producer that exists in the authored workflow but is SKIP for
  //     this scope DEGRADES the section (its stages run once per workflow —
  //     upstream's linear-walk behavior for lean scopes) with a
  //     `scope_absent_unit_dag` warning; only a producer that exists NOWHERE
  //     stays fatal.
  const sections = [];
  {
    const producesUnitDag = (s) =>
      (s.outputArtifacts ?? []).some((o) => (o.artifact ?? o) === UNIT_DAG_ARTIFACT);
    // Scope-agnostic: does any once-per-workflow placement in the authored
    // workflow produce the unit DAG? Same qualifier as the in-scope gate (a
    // forEach producer can never gate a fan-out — not even its own), applied
    // workflow-wide to tell a scope shortcut from a genuine authoring gap.
    // The in-scope variant tells an ORDERING bug (producer in scope but after
    // the section — stays fatal) apart from the out-of-scope shortcut.
    const unitDagProducerPlacements = (workflow.placements ?? []).filter((p) => {
      const st = stagesById[p.stageId];
      return st && st.forEach !== UNIT_FOR_EACH && (st.produces ?? []).includes(UNIT_DAG_ARTIFACT);
    });
    const workflowHasUnitDagProducer = unitDagProducerPlacements.length > 0;
    const inScopeHasUnitDagProducer = unitDagProducerPlacements.some((p) =>
      inScopeIds.has(p.stageId),
    );
    let dagProducerSeen = false;
    let current = null;
    for (const s of orderedStages) {
      if (s.forEach != null && s.forEach !== UNIT_FOR_EACH) {
        errors.push(
          err(
            'unsupported_for_each',
            `stage "${s.stageId}" declares forEach "${s.forEach}"; only "${UNIT_FOR_EACH}" is schedulable`,
            { stageId: s.stageId, ref: s.forEach },
          ),
        );
      }
      if (s.forEach === UNIT_FOR_EACH) {
        if (!current) {
          current = {
            index: sections.length + 1,
            stageIds: [],
            hasUnitDagProducer: dagProducerSeen,
          };
          sections.push(current);
        }
        s.parallelSection = current.index;
        current.stageIds.push(s.stageId);
      } else {
        current = null;
      }
      // A producer inside a section could not gate its own section's fan-out,
      // so only non-forEach producers count — checked after section membership.
      if (s.forEach !== UNIT_FOR_EACH && producesUnitDag(s)) dagProducerSeen = true;
    }
    const degradedIndexes = new Set();
    for (const section of sections) {
      if (!section.hasUnitDagProducer) {
        // Degrade ONLY when the producer is genuinely out of scope (the lean-
        // scope shortcut). A producer that IS in scope but sits after the
        // section (an ordering bug) — or exists nowhere — stays fatal.
        if (workflowHasUnitDagProducer && !inScopeHasUnitDagProducer) {
          warnings.push(
            err(
              'scope_absent_unit_dag',
              `parallel section ${section.index} (${section.stageIds.join(', ')}) has no in-scope producer of "${UNIT_DAG_ARTIFACT}"; its stages run once per workflow (degraded)`,
              { ref: section.stageIds },
            ),
          );
          degradedIndexes.add(section.index);
        } else {
          errors.push(
            err(
              'no_unit_dag_producer',
              `parallel section ${section.index} (${section.stageIds.join(', ')}) has no in-scope upstream stage producing "${UNIT_DAG_ARTIFACT}"`,
              { ref: section.stageIds },
            ),
          );
        }
      }
      delete section.hasUnitDagProducer;
    }
    // Degrade: clear the section stamp so planSegments routes these stages
    // through the plain once-per-workflow loop, and mark each instance so the
    // runtime's unit-lane invariants (run-stage's unit_required) stand down.
    if (degradedIndexes.size > 0) {
      for (const s of orderedStages) {
        if (s.parallelSection != null && degradedIndexes.has(s.parallelSection)) {
          s.parallelSection = null;
          s.forEachDegraded = true;
        }
      }
      for (let i = sections.length - 1; i >= 0; i -= 1) {
        if (degradedIndexes.has(sections[i].index)) sections.splice(i, 1);
      }
    }
  }

  const plan = { workflowId, workflowVersion, scope, namespace, stages: orderedStages, sections };
  return { valid: errors.length === 0, errors, warnings, plan };
};

// Split an ordered plan-stage list into an alternating sequence of segments the
// orchestrator walks: `{ kind: 'stages', stages }` (once-per-workflow, run as
// today) and `{ kind: 'section', index, stages }` (a parallel section — fan-out
// over the execution's unit plan; WP4 runs its lanes sequentially, WP5 in
// parallel). Pure + deterministic; consumes the `parallelSection` stamps.
const planSegments = (stages) => {
  const segments = [];
  for (const s of stages ?? []) {
    const last = segments[segments.length - 1];
    if (s.parallelSection != null) {
      if (last?.kind === 'section' && last.index === s.parallelSection) last.stages.push(s);
      else segments.push({ kind: 'section', index: s.parallelSection, stages: [s] });
    } else {
      if (last?.kind === 'stages') last.stages.push(s);
      else segments.push({ kind: 'stages', stages: [s] });
    }
  }
  return segments;
};

module.exports = {
  buildExecutionPlan,
  planSegments,
  stageInstanceId,
  workflowScopes,
  RUNNABLE_MODES,
  UNIT_FOR_EACH,
  UNIT_DAG_ARTIFACT,
};
