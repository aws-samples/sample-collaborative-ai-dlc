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

// Every validation failure is a plain object (never thrown) so the caller can
// surface all reasons at once and reject cleanly.
const err = (code, message, extra = {}) => ({ code, message, ...extra });

// Deterministic stage-instance id: stable for a given (namespace, stageId), with
// no time/random input, so the same execution re-resolves to identical ids
// (re-entrancy + reproducible tests). The execution id namespaces instances;
// absent one (a dry plan), the immutable workflow pin is the namespace.
const stageInstanceId = (namespace, stageId) =>
  `si-${createHash('sha256').update(`${namespace}:${stageId}`).digest('hex').slice(0, 16)}`;

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
    return { valid: false, errors, plan: null };
  }

  // Project the workflow onto the scope: only EXECUTE placements become stage
  // instances. Cycle/dangling analysis runs over this subset, not the whole
  // authored workflow.
  const placements = (workflow.placements ?? []).filter((p) => isInScope(p, scope));
  const inScopeIds = new Set(placements.map((p) => p.stageId));

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

  // A dangling consume (consumed but produced by no in-scope stage) is fatal
  // UNLESS the edge is allowed to dangle: an optional input (required:false) or
  // one gated on a run condition (conditionalOn — e.g. brownfield). Required,
  // unconditional dangles fail the plan.
  for (const { stageId, artifact } of graph.danglingConsumes) {
    const input = stageInputs(stagesById[stageId]).find((i) => i.artifact === artifact);
    const allowed = input && (input.required === false || input.conditionalOn != null);
    if (!allowed) {
      errors.push(
        err(
          'dangling_consume',
          `stage "${stageId}" consumes "${artifact}", which no in-scope stage produces`,
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
      const inputArtifacts = stageInputs(stage).map((i) => ({
        artifact: i.artifact,
        required: i.required,
        conditionalOn: i.conditionalOn,
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
      };

      // `agent-team` is a known-but-unrunnable mode. Flag, don't crash.
      if (!RUNNABLE_MODES.includes(instance.mode)) {
        instance.notImplemented = true;
        instance.runtimeError = 'not_implemented';
      }
      return instance;
    })
    .filter(Boolean)
    // Stable order for a reproducible plan document.
    .toSorted((a, b) => a.order - b.order || a.stageId.localeCompare(b.stageId));

  const plan = { workflowId, workflowVersion, scope, stages };
  return { valid: errors.length === 0, errors, plan };
};

module.exports = {
  buildExecutionPlan,
  stageInstanceId,
  workflowScopes,
  RUNNABLE_MODES,
};
