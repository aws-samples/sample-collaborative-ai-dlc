'use strict';

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
//     SK = OUTPUT#<seq>               — agent output chunks (restore-on-reload)
//     SK = SENSOR#<ts>#<sensorRunId>  — a deterministic sensor verdict for a stage
//     SK = STEER#<ts>#<steerId>       — a human steering/course-correction message
//   GSI1PK = PROJECT#<projectId>      GSI1SK = STATUS#<status>#STARTED#<ts>#EXEC#<id>
//     (list a project's executions by status, newest first)
//   GSI2PK = EXEC#<executionId>       GSI2SK = TYPE#<type>#STATE#<state>#<id>
//     (query one execution's records by record type + state)

const META = 'META';

// ── Partition keys ──
const executionPk = (executionId) => `EXEC#${executionId}`;
const projectPk = (projectId) => `PROJECT#${projectId}`;

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
// Per-stage runtime status. The container drives a stage RUNNING → terminal; a
// stage that opens a human gate parks on WAITING_FOR_HUMAN.
const STAGE_STATE = ['PENDING', 'RUNNING', 'WAITING_FOR_HUMAN', 'SUCCEEDED', 'FAILED', 'SKIPPED'];
// Human gate kinds + lifecycle. `superseded` retires a still-pending gate whose
// run was cancelled/rewound — never answered, kept as the audit record.
const HUMAN_TASK_KINDS = ['approval', 'question', 'review-verdict'];
const HUMAN_TASK_STATUSES = ['pending', 'answered', 'approved', 'rejected', 'superseded'];
// Human steering (course-correction) messages. Immutable once written; a
// correction of a correction supersedes the old row. Delivery ("consumed") only
// happens at a deterministic injection point: a gate resume or a fresh stage
// start (docs/v2-steering.md).
//   gate-steer — attached to a gate answer; injected on that gate's resume.
//   revision   — corrects an already-answered gate; injected at the next point.
//   rewind     — guidance for a restart-from-stage; injected into that stage.
const STEERING_KINDS = ['gate-steer', 'revision', 'rewind'];
const STEERING_STATUSES = ['pending', 'consumed', 'superseded'];

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
  startedAt,
  // Intent configuration captured at create, read by the orchestrator at Start
  // and forwarded to init-ws/run-stage (one place owns the run config — see
  // docs/v2-data-model.md). `repos` is the array of clone targets (owner/repo).
  title = null,
  prompt = null,
  branch = null,
  baseBranch = null,
  repos = null,
  // The project's selected agent CLI (claude|kiro|…) snapshotted at create; the
  // orchestrator forwards it to run-stage as `requestedCli` so the run honours the
  // project's explicit choice (selection depends on which CLI is authed). null =
  // let run-stage pick the first installed CLI (the test-harness path).
  agentCli = null,
  // Per-CLI model selection ({ claude, kiro }) snapshotted from the project at
  // create; the orchestrator forwards it to run-stage (cliModels[cli] is the
  // authoritative model knob — see v2-agent.md). null = use run-stage defaults.
  cliModels = null,
  // Seconds a parked stage's warm microVM lingers before the orchestrator frees
  // it via StopRuntimeSession (v2-open.md D1). null = use the runtime default.
  parkReleaseSeconds = null,
  // Optional tracker reference the intent was kicked off from (GitHub issue,
  // Jira artifact, …). The imported text lives in `prompt`; this is just the
  // provenance link surfaced in the UI. null when typed by hand. Mirrors the v1
  // Sprint.tracker shape: { provider, instance, bindingId, resourceType,
  // resourceId, resourceUrl }.
  source = null,
  // The live orchestrator run's ownership token (v2-steering.md): minted by the
  // durable orchestrator at mark-running and CAS-checked on its terminal writes,
  // so a retired run (cancel/rewind relaunch) can never clobber META.
  orchestratorRunId = null,
  // Set when this run was relaunched from a mid-plan stage (rewind). Purely
  // informational — explains why upstream stages show SUCCEEDED from a prior run.
  rewindFromStageId = null,
}) => ({
  ...executionMetaKey(executionId),
  ...projectStatusIndex({ projectId, status, startedAt, executionId }),
  ...executionTypeStateIndex({ executionId, type: 'EXECUTION', state: status, id: META }),
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
  startedAt,
  title,
  prompt,
  branch,
  baseBranch,
  repos,
  agentCli,
  cliModels,
  parkReleaseSeconds,
  source,
  orchestratorRunId,
  rewindFromStageId,
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
  now,
}) => ({
  ...stageKey(executionId, stageInstanceId),
  ...executionTypeStateIndex({ executionId, type: 'STAGE', state, id: stageInstanceId }),
  type: 'Stage',
  executionId,
  stageInstanceId,
  stageId: stageId ?? null,
  phase,
  state,
  attempt,
  workerId,
  cli,
  cliSessionId,
  resolvedModel,
  runtimeError: null,
  startedAt: state === 'RUNNING' ? now : null,
  completedAt: null,
  updatedAt: now,
});

const buildEventRow = ({
  executionId,
  type,
  stageInstanceId = null,
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
  actor,
  summary,
  payloadRef,
  timestamp: now,
});

const buildHumanTaskRow = ({
  executionId,
  humanTaskId,
  stageInstanceId = null,
  kind,
  prompt = null,
  options = null,
  questions = null,
  status = 'pending',
  now,
}) => ({
  ...humanTaskKey(executionId, humanTaskId),
  ...executionTypeStateIndex({ executionId, type: 'HUMAN', state: status, id: humanTaskId }),
  type: 'HumanTask',
  executionId,
  humanTaskId,
  stageInstanceId,
  kind,
  status,
  prompt,
  options,
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
  seq,
  kind = 'text',
  content,
  now,
}) => ({
  ...outputKey(executionId, seq),
  ...executionTypeStateIndex({ executionId, type: 'OUTPUT', state: kind, id: outputSeq(seq) }),
  type: 'Output',
  executionId,
  stageInstanceId,
  seq,
  kind,
  content,
  timestamp: now,
});

const buildMetricRow = ({
  executionId,
  stageInstanceId = null,
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
  metricId,
  resolvedModel,
  creditRate,
  // Free-form numeric bag: tokensInput, tokensOutput, contextWindowPct, ...
  metrics: metrics ?? {},
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

module.exports = {
  META,
  executionPk,
  projectPk,
  executionMetaKey,
  stageKey,
  eventKey,
  humanTaskKey,
  metricKey,
  sensorRunKey,
  steeringKey,
  outputKey,
  outputSeq,
  projectStatusIndex,
  executionTypeStateIndex,
  EXECUTION_STATUS,
  STAGE_STATE,
  HUMAN_TASK_KINDS,
  HUMAN_TASK_STATUSES,
  STEERING_KINDS,
  STEERING_STATUSES,
  buildExecutionMeta,
  buildStageRow,
  buildEventRow,
  buildHumanTaskRow,
  buildMetricRow,
  buildSensorRow,
  buildSteeringRow,
  buildOutputRow,
};
