// V2 execution/process state — DynamoDB key scheme + pure record builders.
//
// This is the SINGLE source of truth for the v2 process table layout, shared by
// the AgentCore container (which writes status as it runs stages) and any future
// trigger/resume lambda (which reads execution state and answers human gates).
// Pure — no AWS SDK — so it imports cleanly into the container, the lambdas, and
// the unit suite alike. The thin DynamoDB I/O shell lives in v2-process-store.js.
//
// Data ownership (docs/v2-data-model.md): BUSINESS artifacts live in Neptune;
// PROCESS/runtime state (executions, per-stage status, events, human gates,
// metrics, current phase/stage) lives here in DynamoDB. The two reference each
// other by id but never duplicate each other's authority.
//
// Single-table layout (one execution = one partition):
//   PK = EXEC#<executionId>
//     SK = META                       — execution header (status, intent, current phase/stage)
//     SK = STAGE#<stageInstanceId>    — per-stage runtime status
//     SK = EVENT#<ts>#<eventId>       — append-only audit trail
//     SK = HUMAN#<humanTaskId>        — a pending/answered human gate (question/approval)
//     SK = METRIC#<ts>#<metricId>     — token usage / context-window samples
//     SK = READ#<ts>#<readId>         — graph read/context usage ledger samples
//     SK = OUTPUT#<seq>               — agent output chunks (restore-on-reload)
//     SK = SENSOR#<ts>#<sensorRunId>  — a deterministic sensor verdict for a stage
//     SK = STEER#<ts>#<steerId>       — a human steering/course-correction message
//     SK = QEDIT#<editId>             — a Quorum-supported artifact edit session
//     SK = COMPOSE#<composeId>        — a composer session (scope/grid proposal)
//     SK = UNIT#S<section>#<slug>      — one section-specific unit lane
//     SK = UNITPR#S<section>#<slug>#<repo> — one repository unit PR/MR
//     SK = FEEDBACK#S<section>#<slug>#<batch> — authenticated review batch
//     SK = FEEDBACKCOMMENT#S<section>#<slug>#<comment-version> — exactly-once claim
//   GSI1PK = PROJECT#<projectId>      GSI1SK = STATUS#<status>#STARTED#<ts>#EXEC#<id>
//     (list a project's executions by status, newest first)
//   GSI2PK = EXEC#<executionId>       GSI2SK = TYPE#<type>#STATE#<state>#<id>
//     (query one execution's records by record type + state)
//   GSI3PK = ACTIVE_EXECUTIONS | PR_WAITS
//     GSI3SK = EXEC#<executionId>[#UNIT#S<section>#<slug>]
//     (sparse maintenance index: only live executions and parked unit PR waits)

const META = 'META';

// ── Partition keys ──
const executionPk = (executionId) => `EXEC#${executionId}`;
const projectPk = (projectId) => `PROJECT#${projectId}`;
const ACTIVE_EXECUTIONS_INDEX_PK = 'ACTIVE_EXECUTIONS';
const PR_WAITS_INDEX_PK = 'PR_WAITS';

// ── Item keys ──
const executionMetaKey = (executionId) => ({ pk: executionPk(executionId), sk: META });
const stageKey = (executionId, stageInstanceId) => ({
  pk: executionPk(executionId),
  sk: `STAGE#${stageInstanceId}`,
});
const eventKey = (executionId, timestamp, eventId) => ({
  pk: executionPk(executionId),
  sk: `EVENT#${timestamp}#${eventId}`,
});
const humanTaskKey = (executionId, humanTaskId) => ({
  pk: executionPk(executionId),
  sk: `HUMAN#${humanTaskId}`,
});
const metricKey = (executionId, timestamp, metricId) => ({
  pk: executionPk(executionId),
  sk: `METRIC#${timestamp}#${metricId}`,
});
const graphReadKey = (executionId, timestamp, readId) => ({
  pk: executionPk(executionId),
  sk: `READ#${timestamp}#${readId}`,
});
const sensorRunKey = (executionId, timestamp, sensorRunId) => ({
  pk: executionPk(executionId),
  sk: `SENSOR#${timestamp}#${sensorRunId}`,
});
// Steering rows sort by creation time (like EVENT#) so pending course
// corrections are injected in the order the humans gave them.
const steeringKey = (executionId, timestamp, steerId) => ({
  pk: executionPk(executionId),
  sk: `STEER#${timestamp}#${steerId}`,
});
// Output chunks use a zero-padded monotonic sequence so SK sort == emit order
// (a timestamp can collide for rapid chunks; a sequence can't).
const outputSeq = (n) => String(n).padStart(12, '0');
const outputKey = (executionId, seq) => ({
  pk: executionPk(executionId),
  sk: `OUTPUT#${outputSeq(seq)}`,
});
// Unit-of-work promotion (docs/v2-parallel.md WP3): UNITPLAN is the singleton
// scheduling snapshot (like META); UNIT#<slug> is one lane's state row. The
// DDB rows are the SCHEDULING TRUTH — the Neptune mirror is traceability only.
// NOTE: SK prefix filters must use exact 'UNITPLAN' and 'UNIT#' — a bare
// begins_with 'UNIT' would match both.
const unitPlanKey = (executionId) => ({
  pk: executionPk(executionId),
  sk: 'UNITPLAN',
});
const encodedKeyPart = (value) => encodeURIComponent(String(value));
const unitLaneId = (sectionIndex, slug) =>
  sectionIndex === null || sectionIndex === undefined
    ? String(slug)
    : `S${sectionIndex}#${encodedKeyPart(slug)}`;
// Two-argument calls retain the legacy slug-only key for backward-compatible
// reads/tests. New writes pass sectionIndex + slug.
const unitKey = (executionId, sectionIndexOrSlug, maybeSlug) => {
  const legacy = maybeSlug === undefined;
  const sectionIndex = legacy ? null : sectionIndexOrSlug;
  const slug = legacy ? sectionIndexOrSlug : maybeSlug;
  return {
    pk: executionPk(executionId),
    sk: `UNIT#${unitLaneId(sectionIndex, slug)}`,
  };
};
const unitPrKey = (executionId, sectionIndex, slug, repoId) => ({
  pk: executionPk(executionId),
  sk: `UNITPR#${unitLaneId(sectionIndex, slug)}#${encodedKeyPart(repoId)}`,
});
const feedbackBatchKey = (executionId, sectionIndex, slug, batchId) => ({
  pk: executionPk(executionId),
  sk: `FEEDBACK#${unitLaneId(sectionIndex, slug)}#${encodedKeyPart(batchId)}`,
});
const feedbackCommentKey = (executionId, sectionIndex, slug, comment) => ({
  pk: executionPk(executionId),
  sk: `FEEDBACKCOMMENT#${unitLaneId(sectionIndex, slug)}#${encodedKeyPart(
    `${comment.repository}\u0000${comment.id}\u0000${comment.version}`,
  )}`,
});
// Quorum-supported artifact edit sessions (post-hoc document editing). One row
// per edit request: the change description, Quorum's structured update plan,
// the human approval decision, and the apply outcome. The durable orchestrator
// drives the lifecycle; `callbackId` (stamped while AWAITING_APPROVAL) is the
// suspended decision callback the intents lambda completes — the same
// resume-by-callback pattern as HUMAN# gates.
const quorumEditKey = (executionId, editId) => ({
  pk: executionPk(executionId),
  sk: `QEDIT#${editId}`,
});
// Composer sessions (Adaptive Workflows): one row per compose request — the
// request context, the composer's validated proposal, and the authoritative
// plan-resolver verdict for it. The proposal is DATA: applying it (writing the
// intent's scope/composedGrid) is always a separate human action, never done
// by the compose job itself.
const composeKey = (executionId, composeId) => ({
  pk: executionPk(executionId),
  sk: `COMPOSE#${composeId}`,
});

// ── Index projections ──
// GSI1: a project's executions by status, newest first (status board / resume).
const projectStatusIndex = ({ projectId, status, startedAt, executionId }) => ({
  GSI1PK: projectPk(projectId),
  GSI1SK: `STATUS#${status}#STARTED#${startedAt}#EXEC#${executionId}`,
});
// GSI2: one execution's records by record type + state (e.g. all pending HUMAN
// gates, the RUNNING stage). `type` is EXECUTION | STAGE | EVENT | HUMAN | METRIC.
const executionTypeStateIndex = ({ executionId, type, state, id }) => ({
  GSI2PK: executionPk(executionId),
  GSI2SK: `TYPE#${type}#STATE#${state}#${id}`,
});
const activeExecutionIndex = ({ executionId }) => ({
  GSI3PK: ACTIVE_EXECUTIONS_INDEX_PK,
  GSI3SK: `EXEC#${executionId}`,
});
const unitPrWaitIndex = ({ executionId, sectionIndex, slug }) => ({
  GSI3PK: PR_WAITS_INDEX_PK,
  GSI3SK: `EXEC#${executionId}#UNIT#${unitLaneId(sectionIndex, slug)}`,
});

// ── Vocabularies ──
// Execution-level status (the run as a whole). DRAFT is the pre-Start state:
// the intent's META row exists (config captured) but init-ws/run-stage have not
// been invoked yet, so there is no Neptune Intent anchor. Start transitions
// DRAFT → CREATED → RUNNING.
const EXECUTION_STATUS = [
  'DRAFT',
  'CREATED',
  'RUNNING',
  'WAITING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
];
const ACTIVE_EXECUTION_STATUSES = ['CREATED', 'RUNNING', 'WAITING'];
// Per-stage runtime status. The container drives a stage RUNNING → terminal; a
// stage that opens a human gate parks on WAITING_FOR_HUMAN.
const STAGE_STATE = ['PENDING', 'RUNNING', 'WAITING_FOR_HUMAN', 'SUCCEEDED', 'FAILED', 'SKIPPED'];
// Human gate kinds + lifecycle. `superseded` retires a still-pending gate whose
// run was cancelled/rewound — never answered, kept as the audit record.
const HUMAN_TASK_KINDS = ['approval', 'question', 'review-verdict', 'validation'];
const HUMAN_TASK_STATUSES = ['pending', 'answered', 'approved', 'rejected', 'superseded'];
// Human steering (course-correction) messages. Immutable once written; a
// correction of a correction supersedes the old row. Delivery ("consumed") only
// happens at a deterministic injection point: a gate resume or a fresh stage
// start (docs/v2-steering.md).
//   gate-steer — attached to a gate answer; injected on that gate's resume.
//   revision   — corrects an already-answered gate; injected at the next point.
//   rewind     — guidance for a restart-from-stage; injected into that stage.
//   artifact-edit — a document was edited (human simple edit / Quorum edit)
//                while the run was parked; tells the resumed conversation to
//                re-read the changed artifact instead of trusting stale
//                in-conversation content.
const STEERING_KINDS = ['gate-steer', 'revision', 'rewind', 'artifact-edit'];
const STEERING_STATUSES = ['pending', 'consumed', 'superseded'];
// Per-unit construction lane states (docs/v2-parallel.md rule 4 / WP3).
//   PENDING  — promoted, dependencies not yet satisfied
//   READY    — every depends_on lane MERGED; eligible to start
//   RUNNING  — lane executing its per-unit stages
//   MERGING  — lane finished; engine merge into the intent branch in flight
//   MERGED   — lane's work is on the intent branch (terminal success)
//   FAILED   — a lane stage failed terminally (halt-and-ask)
//   BLOCKED  — a depends_on lane FAILED/BLOCKED; never started
const UNIT_STATES = [
  'PENDING',
  'READY',
  'RUNNING',
  'PR_DRAFT',
  'RECONCILING',
  'PR_READY',
  'ADDRESSING_FEEDBACK',
  'MERGING',
  'MERGED',
  'FAILED',
  'BLOCKED',
];
const UNIT_PR_STATES = [
  'UNCHANGED',
  'DRAFT',
  'RECONCILING',
  'READY',
  'CONFLICTED',
  'ADDRESSING_FEEDBACK',
  'MERGED',
  'PARTIALLY_MERGED',
  'CLOSED',
  'FAILED',
];
const FEEDBACK_STATES = ['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED'];
// Construction autonomy ladder (rule 9): chosen once after the walking-skeleton
// gate approves. `gated` = one approval gate per parallel batch; `autonomous` =
// remaining lanes run without approval gates (failures still halt-and-ask).
const CONSTRUCTION_AUTONOMY_MODES = ['gated', 'autonomous'];
// Quorum-supported artifact edit lifecycle (post-hoc document editing):
//   PLANNING          — Quorum is analyzing downstream impact / drafting a plan
//   AWAITING_APPROVAL — plan is on the row; parked on the decision callback
//   APPLYING          — approved; Quorum is updating the approved artifacts
//   SUCCEEDED/FAILED  — terminal apply outcome
//   REJECTED          — the human rejected the plan (terminal, nothing changed)
//   CANCELLED         — retired without a decision (terminal)
const QUORUM_EDIT_STATES = [
  'PLANNING',
  'AWAITING_APPROVAL',
  'APPLYING',
  'SUCCEEDED',
  'FAILED',
  'REJECTED',
  'CANCELLED',
];
const QUORUM_EDIT_TERMINAL_STATES = ['SUCCEEDED', 'FAILED', 'REJECTED', 'CANCELLED'];

// Composer session lifecycle:
//   PENDING   — dispatched (or being answered deterministically)
//   COMPLETED — a validated proposal is on the row
//   FAILED    — degraded compose (CLI failure, unparseable output, invalid
//               grid) — the row carries the structured reason, never a guess
const COMPOSE_STATES = ['PENDING', 'COMPLETED', 'FAILED'];
const COMPOSE_MODES = ['front', 'report', 'inflight'];

// ── Pure record builders ──
// Every builder takes injected `now`/ids so callers/tests stay deterministic
// (no hidden Date.now()/randomUUID here).

const buildExecutionMeta = ({
  executionId,
  projectId,
  intentId,
  status = 'CREATED',
  workflowId,
  workflowVersion,
  scope = null,
  currentPhase = null,
  currentStage = null,
  pendingHumanTaskId = null,
  startedBy = null,
  starterName = null,
  starterEmail = null,
  startedAt,
  // Intent configuration captured at create, read by the orchestrator at Start
  // and forwarded to init-ws/run-stage (one place owns the run config — see
  // docs/v2-data-model.md). `repos` is the array of clone targets (owner/repo).
  title = null,
  prompt = null,
  gitProvider = null,
  branch = null,
  baseBranch = null,
  // Per-repo base-branch override ({ [repoUrl]: branchName }), snapshotted at
  // create (see lambda/intents validateBaseBranches). A repo absent from this
  // map falls back to `baseBranch`, then to its own actual default branch —
  // resolved lazily by checkout/PR steps, never hardcoded here. null when the
  // caller didn't override anything (the common case).
  baseBranches = null,
  repos = null,
  // Provider lookup by repository id. Most projects use one provider and keep
  // `gitProvider` as the fallback; this map preserves mixed-provider projects
  // without changing the long-standing string shape of `repos`.
  repoProviders = null,
  // The project's selected agent CLI (claude|kiro|…) snapshotted at create; the
  // orchestrator forwards it to run-stage as `requestedCli` so the run honours the
  // project's explicit choice (selection depends on which CLI is authed). null =
  // let run-stage pick the first installed CLI (the test-harness path).
  agentCli = null,
  // Per-CLI model selection ({ claude, kiro }) snapshotted from the project at
  // create; the orchestrator forwards it to run-stage (cliModels[cli] is the
  // authoritative model knob — see v2-agent.md). null = use run-stage defaults.
  cliModels = null,
  // Tier-model config (shared/tier-models.js flat-row shape) snapshotted from
  // project-over-global at create: maps each agent's tier (judgment | balanced
  // | templated) to a model per CLI, plus the fallback and Quorum rows. The
  // orchestrator forwards it on every model-resolving dispatch. null = none.
  tierModels = null,
  // Custom MCP servers — snapshotted at create as TWO SEPARATE name-keyed maps
  // (global + project), each holding only `${VAR}` references (no secret values).
  // The tiers are kept apart so the runtime resolves each tier's secrets against
  // its own SSM prefix (tenant isolation) and merges only AFTER resolution. The
  // orchestrator forwards `mcpServersByTier` to run-stage. null = none.
  //   mcpServersByTier = { global: {<name>:{…}}, project: {<name>:{…}} }
  mcpServersByTier = null,
  // Legacy pre-tier field: a single merged name-keyed map (secrets inline). Still
  // read for back-compat when replaying an OLD execution row, but no longer
  // written. null = none / superseded by mcpServersByTier.
  customMcpServers = null,
  // Custom agent rules metadata ([{ filename, s3Key }]) snapshotted at create
  // from the project; the orchestrator forwards it to run-stage which fetches
  // each .md from S3 and injects it into the agent context. null = none.
  customRules = null,
  // Derive-time graph enrichment mode ('off'|'llm') snapshotted from the Admin
  // SSM setting at create; the orchestrator forwards it in the derive-artifacts
  // payload. Snapshotting keeps a run's behaviour stable even if the Admin
  // flips the toggle mid-flight. null = off.
  deriveEnrichment = null,
  // Seconds a parked stage's warm microVM lingers before the orchestrator frees
  // it via StopRuntimeSession (v2-open.md D1). null = use the runtime default.
  parkReleaseSeconds = null,
  // Concurrency cap for parallel unit lanes (docs/v2-parallel.md WP5),
  // snapshotted from the project at create. 0/null = unbounded (DAG-limited).
  maxParallelUnits = null,
  // PR strategy at fan-in (docs/v2-parallel.md WP6), snapshotted from the
  // project at create. Only 'intent-pr' is enabled until WP6b.
  prStrategy = null,
  // The human's autonomy-ladder decision for construction (docs/v2-parallel.md
  // A2 rule 9): 'autonomous' (remaining lanes run without approval gates) or
  // 'gated' (one approval gate per parallel batch). null until the ladder
  // prompt after the walking-skeleton gate is answered.
  constructionAutonomyMode = null,
  // Optional tracker reference the intent was kicked off from (GitHub issue,
  // Jira artifact, …). The imported text lives in `prompt`; this is just the
  // provenance link surfaced in the UI. null when typed by hand. Mirrors the v1
  // Sprint.tracker shape: { provider, instance, bindingId, resourceType,
  // resourceId, resourceUrl }.
  source = null,
  // Non-fatal plan-resolution warnings snapshotted at create (the pinned
  // workflow + scope resolve to a runnable but DEGRADED plan: required inputs
  // whose producer is out of scope, parallel sections downgraded to
  // once-per-workflow). Shape mirrors the resolver's error objects
  // ({ code, message, stageId?, ref? }); null when the plan is clean. Purely
  // informational — surfaced by the UI so a lean scope's degraded run is
  // visible, never consulted by the engine.
  planWarnings = null,
  // The live orchestrator run's ownership token (v2-steering.md): minted by the
  // durable orchestrator at mark-running and CAS-checked on its terminal writes,
  // so a retired run (cancel/rewind relaunch) can never clobber META.
  orchestratorRunId = null,
  // Lambda durable execution identity + local soft-deadline metadata. The ARN
  // lets maintenance verify AWS durable state before repairing a stale run; the
  // deadline lets the orchestrator avoid parking on a callback that cannot live
  // long enough to be answered.
  durableExecutionName = null,
  durableExecutionArn = null,
  orchestratorStartedAt = null,
  orchestratorExpiresAt = null,
  // Set when this run was relaunched from a mid-plan stage (rewind). Purely
  // informational — explains why upstream stages show SUCCEEDED from a prior run.
  rewindFromStageId = null,
  // Effective stage-skipping mode ('enabled'|'disabled') snapshotted at create
  // (project override over the platform SSM setting — shared/stage-skip.js).
  // Gates BOTH the create-time skip overlay and the gate-time "skip to stage X"
  // options; snapshotting keeps a run's behaviour stable across toggle flips.
  stageSkipping = null,
  // Per-intent skip overlay: stage ids deselected at create (CONDITIONAL-only,
  // validated by the plan resolver). Threaded into EVERY plan recompute
  // (orchestrator load-plan, rewind slice, run-stage resolution) so the plan
  // never drifts. A rewind to one of these ids UN-skips it (removed here).
  skipStageIds = null,
  // Per-intent composed EXECUTE/SKIP grid (Adaptive Workflows): when set it
  // replaces the named-scope projection in every plan recompute — `scope`
  // degrades to the provenance label the grid was composed from. Pinned at
  // create/start like the skip overlay and threaded identically; mutable only
  // through the recompose path, which retires + relaunches the run.
  composedGrid = null,
  attachments = [],
  attachmentRevision = 0,
  pendingAttachmentUploads = [],
  pendingAttachmentDeletions = [],
}) => ({
  ...executionMetaKey(executionId),
  ...projectStatusIndex({ projectId, status, startedAt, executionId }),
  ...executionTypeStateIndex({ executionId, type: 'EXECUTION', state: status, id: META }),
  ...(ACTIVE_EXECUTION_STATUSES.includes(status) ? activeExecutionIndex({ executionId }) : {}),
  type: 'Execution',
  executionId,
  projectId,
  intentId,
  status,
  workflowId,
  workflowVersion,
  scope,
  currentPhase,
  currentStage,
  pendingHumanTaskId,
  startedBy,
  starterName,
  starterEmail,
  startedAt,
  title,
  prompt,
  branch,
  baseBranch,
  baseBranches,
  repos,
  repoProviders,
  gitProvider,
  agentCli,
  cliModels,
  tierModels,
  mcpServersByTier,
  customMcpServers,
  customRules,
  deriveEnrichment,
  parkReleaseSeconds,
  maxParallelUnits,
  prStrategy,
  constructionAutonomyMode,
  source,
  planWarnings,
  orchestratorRunId,
  durableExecutionName,
  durableExecutionArn,
  orchestratorStartedAt,
  orchestratorExpiresAt,
  rewindFromStageId,
  stageSkipping,
  skipStageIds,
  composedGrid,
  attachments,
  attachmentRevision,
  pendingAttachmentUploads,
  pendingAttachmentDeletions,
  updatedAt: startedAt,
  completedAt: null,
});

const buildStageRow = ({
  executionId,
  stageInstanceId,
  stageId,
  phase = null,
  state = 'PENDING',
  attempt = 0,
  workerId = null,
  // The headless CLI's conversation handle for this stage, persisted so a resume
  // re-invocation can continue the SAME conversation: `cli` is the driver name
  // (claude|kiro) and `cliSessionId` is the CLI-native session id. Both null on a
  // stage that never spawned a CLI. See docs/v2-resume.md (park/resume).
  cli = null,
  cliSessionId = null,
  // The concrete model this stage resolved to (region-prefixed Bedrock id, Kiro
  // namespace id, or null). Persisted so token metrics can be priced at read time
  // by joining on stageInstanceId — the untrusted agent bag carries no model. See
  // model-pricing.js and docs/v2-metrics.md.
  resolvedModel = null,
  // The durable-execution callback id the orchestrator is suspended on for this
  // stage attempt (async run-stage, docs/v2-parallel.md WP1). The container's
  // background job completes it via SendDurableExecutionCallbackSuccess when the
  // stage exits. Persisted for traceability + manual operator recovery of a
  // stuck stage. Null for rows written outside the async path.
  stageCallbackId = null,
  // The HUMAN# gate this stage is currently parked on. This is the scheduling
  // source of truth for agent questions; META.pendingHumanTaskId is only a
  // legacy/display mirror and cannot represent concurrent lane questions.
  pendingHumanTaskId = null,
  // The unit-of-work lane this stage instance belongs to (docs/v2-parallel.md
  // WP4). Null for once-per-workflow stages; set on `forEach: unit-of-work`
  // instances so every stage row is attributable to its lane.
  unitSlug = null,
  sectionIndex = null,
  now,
}) => ({
  ...stageKey(executionId, stageInstanceId),
  ...executionTypeStateIndex({ executionId, type: 'STAGE', state, id: stageInstanceId }),
  type: 'Stage',
  executionId,
  stageInstanceId,
  stageId: stageId ?? null,
  unitSlug,
  sectionIndex,
  phase,
  state,
  attempt,
  workerId,
  cli,
  cliSessionId,
  resolvedModel,
  stageCallbackId,
  pendingHumanTaskId,
  runtimeError: null,
  startedAt: state === 'RUNNING' ? now : null,
  completedAt: null,
  // Human-wait accounting: `parkedAt` is stamped when the stage parks
  // WAITING_FOR_HUMAN and cleared on resume; `waitMs` accumulates the total
  // parked milliseconds across all park/resume cycles. Together with
  // startedAt/completedAt they yield both wall-clock and agent-active
  // durations (active = total − waitMs − any open park window).
  parkedAt: null,
  waitMs: 0,
  updatedAt: now,
});

const buildEventRow = ({
  executionId,
  type,
  stageInstanceId = null,
  // Lane attribution (docs/v2-parallel.md WP4): the unit-of-work slug when the
  // event originates inside a unit lane; null for workflow-level events.
  unitSlug = null,
  sectionIndex = null,
  actor,
  summary,
  payloadRef = null,
  now,
  eventId,
}) => ({
  ...eventKey(executionId, now, eventId),
  ...executionTypeStateIndex({ executionId, type: 'EVENT', state: type, id: eventId }),
  type: 'Event',
  eventId,
  executionId,
  eventType: type,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  actor,
  summary,
  payloadRef,
  timestamp: now,
});

const buildHumanTaskRow = ({
  executionId,
  humanTaskId,
  stageInstanceId = null,
  // Lane attribution (docs/v2-parallel.md WP4): with N parallel lanes parked on
  // gates at once, a gate must name the unit it belongs to or answers are
  // unattributable. Null for once-per-workflow stage gates.
  unitSlug = null,
  sectionIndex = null,
  kind,
  prompt = null,
  options = null,
  questions = null,
  // Valid "skip to stage X" targets for a validation gate (stage-skip.js):
  // stage ids the human may jump to, every intermediate being CONDITIONAL.
  // Null when stage skipping is disabled or no valid target exists. Purely
  // advisory for the UI — the orchestrator re-validates the answer.
  skipTargets = null,
  // Valid recompose-delta targets for a validation gate: LATER, once-per-
  // workflow, CONDITIONAL stages the approve answer may flip to SKIP via
  // `recompose: { skip: [...] }` (stage-skip.js resolveRecomposeSkips) —
  // arbitrary selection, unlike skipTargets' contiguous jump. Null when
  // stage skipping is disabled or nothing qualifies. Advisory only; the
  // orchestrator re-validates every entry.
  recomposeTargets = null,
  // The COMPUTED next stage a plain approve continues to (upstream 2.2.6):
  // string = its stageId, null = approving completes the workflow. The
  // attribute is written ONLY when the orchestrator computed it (undefined
  // omits it), so legacy rows / non-validation gates stay distinguishable
  // from an explicit "final stage". Display-only — never drives routing.
  nextStageId = undefined,
  status = 'pending',
  now,
}) => ({
  ...humanTaskKey(executionId, humanTaskId),
  ...executionTypeStateIndex({ executionId, type: 'HUMAN', state: status, id: humanTaskId }),
  type: 'HumanTask',
  executionId,
  humanTaskId,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  kind,
  status,
  prompt,
  options,
  skipTargets,
  recomposeTargets,
  ...(nextStageId !== undefined ? { nextStageId } : {}),
  // The v1-shaped structured-questions payload (JSON) when kind==='question'.
  questions,
  answer: null,
  answeredBy: null,
  answeredByName: null,
  answeredAt: null,
  // The durable-execution callback id the orchestrator is suspended on for this
  // gate (set only on the gate the run actually parked on — see v2-open.md D3).
  // The answer path sends SendDurableExecutionCallbackSuccess against it to
  // resume the suspended orchestrator. Null on sibling gates / before park.
  callbackId: null,
  createdAt: now,
});

// An agent output chunk persisted for restore-on-reload. The live copy is
// broadcast over the websocket; this row is the durable record the page replays.
const buildOutputRow = ({
  executionId,
  stageInstanceId = null,
  // Lane attribution (docs/v2-parallel.md WP4); null outside unit lanes.
  unitSlug = null,
  sectionIndex = null,
  seq,
  kind = 'text',
  content,
  display = null,
  now,
}) => {
  const row = {
    ...outputKey(executionId, seq),
    ...executionTypeStateIndex({ executionId, type: 'OUTPUT', state: kind, id: outputSeq(seq) }),
    type: 'Output',
    executionId,
    stageInstanceId,
    unitSlug,
    sectionIndex,
    seq,
    kind,
    content,
    timestamp: now,
  };
  if (display && typeof display === 'object') row.display = display;
  return row;
};

const buildMetricRow = ({
  executionId,
  stageInstanceId = null,
  // Lane attribution (docs/v2-parallel.md WP4); null outside unit lanes.
  unitSlug = null,
  sectionIndex = null,
  metricId,
  metrics,
  // The model in effect when this sample was recorded, stamped server-side from
  // the trusted bridge scope (not the agent bag). Preferred over the stage-row
  // join for pricing; null when the bridge had no model (e.g. stageless metric).
  resolvedModel = null,
  // Kiro only: the $/credit overage rate in effect when a `credits` sample was
  // recorded (scraped from `kiro-cli /usage` by the runner). Stamped per sample
  // so a later plan/rate change never reprices history. Null for token samples.
  creditRate = null,
  now,
}) => ({
  ...metricKey(executionId, now, metricId),
  ...executionTypeStateIndex({ executionId, type: 'METRIC', state: 'sample', id: metricId }),
  type: 'Metric',
  executionId,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  metricId,
  resolvedModel,
  creditRate,
  // Free-form numeric bag: tokensInput, tokensOutput, contextWindowPct, ...
  metrics: metrics ?? {},
  timestamp: now,
});

const buildGraphReadRow = ({
  executionId,
  stageInstanceId = null,
  unitSlug = null,
  sectionIndex = null,
  readId,
  tool,
  bytes = 0,
  resultCount = null,
  args = {},
  now,
}) => ({
  ...graphReadKey(executionId, now, readId),
  ...executionTypeStateIndex({ executionId, type: 'READ', state: 'sample', id: readId }),
  type: 'GraphRead',
  executionId,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  readId,
  tool,
  bytes,
  resultCount,
  args,
  timestamp: now,
});

// A deterministic sensor verdict for a stage. `result` is the SENSOR_RESULT
// enum (PASS/FAIL/INCONCLUSIVE/BLOCKED); `severity` carries the sensor's
// advisory/blocking class so a reader knows whether the result held the stage.
// `detail` is the sensor's structured output (heading counts, unreferenced
// artifacts, violations, …) and `held` records whether this verdict blocked.
const buildSensorRow = ({
  executionId,
  stageInstanceId = null,
  // Lane attribution (docs/v2-parallel.md WP4); null outside unit lanes.
  unitSlug = null,
  sectionIndex = null,
  sensorRunId,
  sensorId,
  kind,
  severity,
  result,
  held = false,
  detail = null,
  now,
}) => ({
  ...sensorRunKey(executionId, now, sensorRunId),
  ...executionTypeStateIndex({ executionId, type: 'SENSOR', state: result, id: sensorRunId }),
  type: 'SensorRun',
  executionId,
  stageInstanceId,
  unitSlug,
  sectionIndex,
  sensorRunId,
  sensorId,
  kind,
  severity,
  result,
  held,
  detail,
  timestamp: now,
});

// A human steering / course-correction message (docs/v2-steering.md). Human-
// initiated (the inverse of a HUMAN# gate), immutable, and delivered to the
// agent only at a deterministic injection point — a gate resume or a fresh
// stage start — where it flips pending → consumed (CAS). `targetGateId` links a
// gate-steer/revision to its gate; `targetStageId` names a rewind's restart
// stage. GSI2 state = status so "all pending steering" is one query.
const buildSteeringRow = ({
  executionId,
  steerId,
  kind,
  message,
  targetGateId = null,
  targetStageId = null,
  status = 'pending',
  createdBy = null,
  createdByName = null,
  now,
}) => ({
  ...steeringKey(executionId, now, steerId),
  ...executionTypeStateIndex({ executionId, type: 'STEER', state: status, id: steerId }),
  type: 'Steering',
  executionId,
  steerId,
  kind,
  status,
  message,
  targetGateId,
  targetStageId,
  createdBy,
  createdByName,
  createdAt: now,
  // Set when the message enters an agent conversation (pending → consumed).
  consumedAt: null,
  consumedByStageInstanceId: null,
  // Set when a newer correction retires this one (pending → superseded).
  supersededAt: null,
  supersededBy: null,
});

// The UNITPLAN snapshot (docs/v2-parallel.md WP3): frozen on promotion of the
// approved unit-of-work-dependency artifact. Everything the scheduler needs is
// HERE (DDB = scheduling truth; bolt-plan prose is never parsed for execution):
//   units          — [{ slug, dependsOn: [slug], kind }] from parseBoltDag
//                    (kind: unit-of-work kind or null — drives produces_kinds
//                    pruning at per-unit dispatch)
//   batches        — [[slug]] topological waves (the batch-barrier fallback)
//   skipMatrix     — { [slug]: [stageId] } per-unit CONDITIONAL stages to skip;
//                    {} (default) = every unit executes every per-unit stage.
//                    Frozen from the human-approved matrix at the fan-out approval (the unit-DAG stage gate).
//   walkingSkeleton— slug of the lane that runs SOLO first (rule 8)
//   autonomyMode   — 'gated' | 'autonomous' (rule 9); null until the ladder
//                    prompt after the skeleton gate
// Re-promotion (rewind of units-generation) overwrites the snapshot; UNIT rows
// are synced separately with active-lane protection (see the store).
const buildUnitPlanRow = ({
  executionId,
  units,
  batches,
  sourceArtifactId = null,
  producedByStageInstanceId = null,
  skipMatrix = {},
  walkingSkeleton = null,
  autonomyMode = null,
  promotedBy = 'engine',
  now,
}) => ({
  ...unitPlanKey(executionId),
  ...executionTypeStateIndex({ executionId, type: 'UNITPLAN', state: 'ACTIVE', id: 'UNITPLAN' }),
  type: 'UnitPlan',
  executionId,
  units,
  batches,
  unitCount: units.length,
  sourceArtifactId,
  producedByStageInstanceId,
  skipMatrix,
  walkingSkeleton,
  autonomyMode,
  promotedBy,
  promotedAt: now,
  updatedAt: now,
});

// One unit lane's scheduling row. GSI2 state = lane state so "all READY lanes"
// is one query. `batchIndex` is the unit's topological wave (informational —
// the wavefront schedules off dependsOn, not batches). Branch/session fields
// are stamped when the lane starts (WP5); terminal fields on merge/fail.
const buildUnitRow = ({
  executionId,
  sectionIndex = null,
  slug,
  dependsOn = [],
  kind = null,
  state = 'PENDING',
  batchIndex = 0,
  now,
}) => ({
  ...unitKey(executionId, sectionIndex, slug),
  ...executionTypeStateIndex({
    executionId,
    type: 'UNIT',
    state,
    id: unitLaneId(sectionIndex, slug),
  }),
  type: 'Unit',
  executionId,
  sectionIndex,
  slug,
  dependsOn,
  kind,
  state,
  batchIndex,
  branch: null,
  sessionId: null,
  startedAt: null,
  mergedAt: null,
  failureReason: null,
  blockedOn: null,
  createdAt: now,
  updatedAt: now,
});

const buildUnitPrRow = ({
  executionId,
  sectionIndex,
  slug,
  repository,
  provider,
  providerId = null,
  number = null,
  url = null,
  sourceBranch,
  targetBranch,
  headSha = null,
  readyHeadSha = null,
  targetSha = null,
  state = 'DRAFT',
  mergeable = null,
  commentCount = 0,
  createdAt = null,
  now,
}) => ({
  ...unitPrKey(executionId, sectionIndex, slug, repository),
  ...executionTypeStateIndex({
    executionId,
    type: 'UNITPR',
    state,
    id: `${unitLaneId(sectionIndex, slug)}#${encodedKeyPart(repository)}`,
  }),
  type: 'UnitPullRequest',
  executionId,
  sectionIndex,
  unitSlug: slug,
  repository,
  provider,
  providerId,
  number,
  url,
  sourceBranch,
  targetBranch,
  headSha,
  readyHeadSha,
  targetSha,
  state,
  mergeable,
  commentCount,
  repositoryOutcome: null,
  createdAt: createdAt ?? now,
  updatedAt: now,
  mergedAt: null,
  closedAt: null,
});

const buildFeedbackBatchRow = ({
  executionId,
  sectionIndex,
  slug,
  batchId,
  comments,
  state = 'QUEUED',
  requestedBy,
  requestedByName = null,
  now,
}) => ({
  ...feedbackBatchKey(executionId, sectionIndex, slug, batchId),
  ...executionTypeStateIndex({
    executionId,
    type: 'FEEDBACK',
    state,
    id: `${unitLaneId(sectionIndex, slug)}#${batchId}`,
  }),
  type: 'FeedbackBatch',
  executionId,
  sectionIndex,
  unitSlug: slug,
  batchId,
  comments,
  state,
  requestedBy,
  requestedByName,
  stageInstanceId: null,
  output: null,
  changedFiles: null,
  verification: null,
  commitSha: null,
  failureReason: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
});

const buildFeedbackCommentRow = ({ executionId, sectionIndex, slug, batchId, comment, now }) => ({
  ...feedbackCommentKey(executionId, sectionIndex, slug, comment),
  type: 'FeedbackCommentClaim',
  executionId,
  sectionIndex,
  unitSlug: slug,
  batchId,
  repository: comment.repository,
  commentId: String(comment.id),
  version: String(comment.version),
  createdAt: now,
});

// One Quorum-supported artifact edit session. GSI2 state = lifecycle state so
// "any active quorum edit for this execution" is one query. `plan` is Quorum's
// structured update plan ({ summary, items: [{ artifactId, action, rationale,
// proposedChange }] }); decision/outcome fields are stamped as the flow
// progresses. The row is process state — the artifact content itself (and the
// stale/edit provenance props) live in Neptune.
const buildQuorumEditRow = ({
  executionId,
  editId,
  artifactId,
  artifactType = null,
  artifactTitle = null,
  changeDescription,
  state = 'PLANNING',
  requestedBy = null,
  requestedByName = null,
  now,
}) => ({
  ...quorumEditKey(executionId, editId),
  ...executionTypeStateIndex({ executionId, type: 'QEDIT', state, id: editId }),
  type: 'QuorumEdit',
  executionId,
  editId,
  artifactId,
  artifactType,
  artifactTitle,
  changeDescription,
  state,
  requestedBy,
  requestedByName,
  // Quorum's structured update plan; null until planning completes.
  plan: null,
  // The suspended durable decision callback (set while AWAITING_APPROVAL).
  callbackId: null,
  // Human decision.
  decidedBy: null,
  decidedByName: null,
  decidedAt: null,
  approvedArtifactIds: null,
  // Apply outcome.
  updatedArtifactIds: null,
  verifiedArtifactIds: null,
  failedArtifactIds: null,
  failureReason: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
});

// One composer session. `source` records HOW the proposal was produced:
// 'match' (deterministic keyword pre-pass, no LLM) or 'llm' (the composer
// agent). `proposal` is the parsed contract shape ({ mode, scope, grid,
// rationale, confidence }); `validation` is the plan resolver's authoritative
// verdict for it ({ valid, errors, warnings, summary }) — the UI renders the
// validation numbers, never the composer's own claims.
const buildComposeRow = ({
  executionId,
  composeId,
  mode = 'front',
  state = 'PENDING',
  source = 'llm',
  requestedBy = null,
  requestedByName = null,
  instructions = null,
  reportKey = null,
  now,
}) => ({
  ...composeKey(executionId, composeId),
  ...executionTypeStateIndex({ executionId, type: 'COMPOSE', state, id: composeId }),
  type: 'Compose',
  executionId,
  composeId,
  mode,
  state,
  source,
  requestedBy,
  requestedByName,
  instructions,
  // S3 key of the uploaded report (report mode only).
  reportKey,
  proposal: null,
  validation: null,
  failureReason: null,
  createdAt: now,
  updatedAt: now,
  completedAt: null,
});

export {
  META,
  executionPk,
  projectPk,
  executionMetaKey,
  stageKey,
  eventKey,
  humanTaskKey,
  metricKey,
  graphReadKey,
  sensorRunKey,
  steeringKey,
  outputKey,
  outputSeq,
  unitPlanKey,
  unitKey,
  unitLaneId,
  unitPrKey,
  feedbackBatchKey,
  feedbackCommentKey,
  quorumEditKey,
  composeKey,
  projectStatusIndex,
  executionTypeStateIndex,
  activeExecutionIndex,
  unitPrWaitIndex,
  ACTIVE_EXECUTIONS_INDEX_PK,
  PR_WAITS_INDEX_PK,
  EXECUTION_STATUS,
  ACTIVE_EXECUTION_STATUSES,
  STAGE_STATE,
  HUMAN_TASK_KINDS,
  HUMAN_TASK_STATUSES,
  STEERING_KINDS,
  STEERING_STATUSES,
  UNIT_STATES,
  UNIT_PR_STATES,
  FEEDBACK_STATES,
  CONSTRUCTION_AUTONOMY_MODES,
  QUORUM_EDIT_STATES,
  QUORUM_EDIT_TERMINAL_STATES,
  COMPOSE_STATES,
  COMPOSE_MODES,
  buildExecutionMeta,
  buildStageRow,
  buildEventRow,
  buildHumanTaskRow,
  buildMetricRow,
  buildGraphReadRow,
  buildSensorRow,
  buildSteeringRow,
  buildOutputRow,
  buildUnitPlanRow,
  buildUnitRow,
  buildUnitPrRow,
  buildFeedbackBatchRow,
  buildFeedbackCommentRow,
  buildQuorumEditRow,
  buildComposeRow,
};
export default {
  META,
  executionPk,
  projectPk,
  executionMetaKey,
  stageKey,
  eventKey,
  humanTaskKey,
  metricKey,
  graphReadKey,
  sensorRunKey,
  steeringKey,
  outputKey,
  outputSeq,
  unitPlanKey,
  unitKey,
  unitLaneId,
  unitPrKey,
  feedbackBatchKey,
  feedbackCommentKey,
  quorumEditKey,
  composeKey,
  projectStatusIndex,
  executionTypeStateIndex,
  activeExecutionIndex,
  unitPrWaitIndex,
  ACTIVE_EXECUTIONS_INDEX_PK,
  PR_WAITS_INDEX_PK,
  EXECUTION_STATUS,
  ACTIVE_EXECUTION_STATUSES,
  STAGE_STATE,
  HUMAN_TASK_KINDS,
  HUMAN_TASK_STATUSES,
  STEERING_KINDS,
  STEERING_STATUSES,
  UNIT_STATES,
  UNIT_PR_STATES,
  FEEDBACK_STATES,
  CONSTRUCTION_AUTONOMY_MODES,
  QUORUM_EDIT_STATES,
  QUORUM_EDIT_TERMINAL_STATES,
  COMPOSE_STATES,
  COMPOSE_MODES,
  buildExecutionMeta,
  buildStageRow,
  buildEventRow,
  buildHumanTaskRow,
  buildMetricRow,
  buildGraphReadRow,
  buildSensorRow,
  buildSteeringRow,
  buildOutputRow,
  buildUnitPlanRow,
  buildUnitRow,
  buildUnitPrRow,
  buildFeedbackBatchRow,
  buildFeedbackCommentRow,
  buildQuorumEditRow,
  buildComposeRow,
};
