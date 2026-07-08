import { api } from './api';

// AI-DLC v2 intents — the v2 unit of work (the v1 sprint analog). An intent
// runs a compiled workflow's stages through dynamic phases. Process/runtime
// state lives in the v2 process table (DynamoDB); business artifacts live in
// Neptune. This service is the typed client over lambda/intents.

export type IntentStatus =
  | 'DRAFT'
  | 'CREATED'
  | 'RUNNING'
  | 'WAITING'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED';

export type StageState =
  | 'PENDING'
  | 'RUNNING'
  | 'WAITING_FOR_HUMAN'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'SKIPPED';

// The tracker issue/artifact an intent was kicked off from. The imported text
// lives in `prompt`; this is the provenance back-link surfaced in the UI. null
// when the prompt was typed by hand.
export interface IntentSource {
  bindingId: string;
  provider: string;
  instance: string | null;
  resourceType: string;
  resourceId: string;
  resourceUrl: string | null;
}

export interface Intent {
  id: string;
  executionId: string;
  projectId: string;
  title: string | null;
  prompt: string | null;
  status: IntentStatus;
  branch: string | null;
  baseBranch: string | null;
  // Per-repo base-branch override ({ [repoUrl]: branchName }); a repo absent
  // from this map falls back to `baseBranch`, then to its own actual default
  // branch. null when the caller didn't override anything (the common case).
  baseBranches: Record<string, string> | null;
  repos: string[] | null;
  workflowId: string;
  workflowVersion: number | null;
  scope: string | null;
  currentPhase: string | null;
  currentStage: string | null;
  pendingHumanTaskId: string | null;
  failureReason: string | null;
  // Set when the run was relaunched from a mid-plan stage (steering rewind).
  rewindFromStageId?: string | null;
  cliModels: Record<string, string> | null;
  parkReleaseSeconds: number | null;
  // WP5 (docs/v2-parallel.md): lane concurrency cap snapshotted at create
  // (0/null = unbounded) and the human's autonomy-ladder decision.
  maxParallelUnits?: number | null;
  constructionAutonomyMode?: 'gated' | 'autonomous' | null;
  source: IntentSource | null;
  // Non-fatal plan warnings snapshotted at create: the selected scope resolves
  // to a runnable but DEGRADED plan (required inputs whose producer stage is
  // out of scope, parallel sections downgraded to once-per-workflow). Null
  // when the plan is clean.
  planWarnings?: PlanWarning[] | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

// Shape mirrors the plan resolver's error objects (lambda/shared/v2-execution-plan.js).
export interface PlanWarning {
  code: string;
  message: string;
  stageId?: string;
  ref?: string | string[];
}

export interface IntentStage {
  stageInstanceId: string;
  stageId: string | null;
  // Unit lane (docs/v2-parallel.md WP4): set on per-unit instances of a
  // `forEach: unit-of-work` stage; null on once-per-workflow stages.
  unitSlug?: string | null;
  phase: string | null;
  state: StageState;
  attempt: number;
  cli: string | null;
  runtimeError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
  // The model the orchestrator resolved for this stage (Bedrock region-prefixed
  // id like `us.anthropic.claude-sonnet-4-6`). Null when the stage ran
  // without model attribution (legacy rows, non-LLM stages).
  resolvedModel?: string | null;
  // Human-wait accounting: accumulated parked milliseconds across park/resume
  // cycles, and the open park's start (null unless WAITING_FOR_HUMAN). Active
  // duration = (completedAt ?? now) − startedAt − waitMs − open park window.
  waitMs?: number;
  parkedAt?: string | null;
}

// A human gate (HUMAN# row). `questions` is the v1-shaped structured-questions
// JSON string when kind === 'question' — parsed into the QuestionEditor shape
// by the IntentView.
export interface IntentGate {
  humanTaskId: string;
  stageInstanceId: string | null;
  // Unit lane attribution (docs/v2-parallel.md WP4); null outside lanes.
  unitSlug?: string | null;
  kind: 'approval' | 'question' | 'review-verdict';
  // `superseded` = the gate was retired unanswered by a cancel/rewind.
  status: 'pending' | 'answered' | 'approved' | 'rejected' | 'superseded';
  prompt: string | null;
  options: unknown;
  questions: string | null;
  answer: unknown;
  answeredBy: string | null;
  answeredByName?: string | null;
  answeredAt: string | null;
  createdAt: string | null;
  // Steering: set when a later correction revised this gate's answer. The
  // original answer stays; the correction is the referenced STEER row.
  revisedAt?: string | null;
  revisionSteerId?: string | null;
  supersededAt?: string | null;
  supersededBy?: string | null;
}

// A human steering / course-correction message (docs/v2-steering.md).
// Human-initiated (the inverse of a gate); delivered to the agent only at a
// deterministic injection point (gate resume / fresh stage start).
export interface IntentSteering {
  steerId: string;
  kind: 'gate-steer' | 'revision' | 'rewind';
  status: 'pending' | 'consumed' | 'superseded';
  message: string | null;
  targetGateId: string | null;
  targetStageId: string | null;
  createdBy: string | null;
  createdByName: string | null;
  createdAt: string | null;
  consumedAt: string | null;
  consumedByStageInstanceId: string | null;
}

// Cost attributed to one metric sample, computed server-side (pricing lives on
// the backend). `priced: false` means the sample's model has no price entry
// (a newer model, or a Kiro credit-based run without a captured rate) — the UI
// shows "cost unavailable" rather than a misleading $0. `estimated: true` means
// the dollars come from Kiro credits priced at the plan's $/credit overage rate
// (an estimate, not billing truth) — the UI caveats it.
export interface MetricCost {
  model: string | null;
  currency: string;
  inputCost: number;
  outputCost: number;
  creditCost?: number;
  totalCost: number;
  priced: boolean;
  estimated?: boolean;
}

export interface IntentMetric {
  metricId: string;
  stageInstanceId: string | null;
  metrics: Record<string, number>;
  timestamp: string;
  // The model attributed to this sample (metric-row stamp, else joined from the
  // stage row) and its computed cost. Absent on legacy rows without a model.
  model?: string | null;
  cost?: MetricCost | null;
}

export interface IntentOutput {
  seq: number;
  stageInstanceId: string | null;
  unitSlug?: string | null;
  kind: string;
  content: string;
  timestamp: string;
}

export interface IntentSensorRun {
  sensorRunId: string;
  stageInstanceId: string | null;
  unitSlug?: string | null;
  sensorId: string;
  result: string;
  severity: string;
  held: boolean;
  // The sensor's structured verdict (e.g. { artifacts: [{ artifact, reason }] },
  // { unreferenced: [...] }, { reason }, { error }). Shape varies per sensor
  // kind; rendered best-effort into a human explanation in the UI.
  detail: SensorDetail | null;
  timestamp: string;
}

// Loosely-typed sensor verdict detail — the fields any evaluator may emit. All
// optional; the UI reads whichever are present.
export interface SensorDetail {
  artifacts?: { artifact: string; reason?: string; id?: string | null }[];
  unreferenced?: string[];
  consumes?: string[];
  reason?: string;
  error?: string;
  findings_count?: number;
  [key: string]: unknown;
}

export interface IntentArtifact {
  id: string;
  artifactType: string | null;
  title: string | null;
  createdByExecutionId: string | null;
  createdByStageInstanceId: string | null;
  createdAt: string | null;
  // Rewind lineage: set while a rewind's supersede has not been rehabilitated
  // by the re-run (dimmed in the UI).
  supersededAt?: string | null;
  supersededBy?: string | null;
  content: string | null;
}

// A lifecycle event in the intent's activity feed (workspace init, failure,
// completion). Emitted by the orchestrator; init-ws progress is otherwise
// invisible because it creates no stage row.
export interface IntentActivityEvent {
  eventId: string;
  type: string;
  stageInstanceId: string | null;
  // Unit lane attribution (docs/v2-parallel.md WP4); null outside lanes.
  unitSlug?: string | null;
  actor: string | null;
  summary: string | null;
  timestamp: string;
  humanTaskId?: string;
  questions?: string | null;
  answer?: unknown;
  answeredBy?: string | null;
  answeredByName?: string | null;
  artifacts?: { id: string; title: string }[];
}

// Unit lanes (docs/v2-parallel.md WP4): the promoted UNITPLAN scheduling
// snapshot and the live per-lane rows. Both empty pre-promotion.
export type UnitState =
  | 'PENDING'
  | 'READY'
  | 'RUNNING'
  | 'MERGING'
  | 'MERGED'
  | 'FAILED'
  | 'BLOCKED';

export interface IntentUnitPlan {
  units: { slug: string; dependsOn: string[] }[];
  batches: string[][];
  unitCount: number;
  skipMatrix: Record<string, string[]>;
  walkingSkeleton: string | null;
  autonomyMode: 'gated' | 'autonomous' | null;
  promotedAt: string | null;
}

export interface IntentUnit {
  slug: string;
  dependsOn: string[];
  state: UnitState;
  batchIndex: number;
  branch: string | null;
  startedAt: string | null;
  mergedAt: string | null;
  failureReason: string | null;
  blockedOn: string | null;
  updatedAt: string | null;
}

// The assembled detail returned by GET /projects/{id}/intents/{intentId}.
export interface IntentDetail {
  intent: Intent;
  stages: IntentStage[];
  events: IntentActivityEvent[];
  gates: IntentGate[];
  steering: IntentSteering[];
  metrics: IntentMetric[];
  outputs: IntentOutput[];
  sensorRuns: IntentSensorRun[];
  artifacts: IntentArtifact[];
  unitPlan?: IntentUnitPlan | null;
  units?: IntentUnit[];
}

export interface CreateIntentInput {
  title?: string;
  prompt?: string;
  branch?: string;
  baseBranch?: string;
  // Per-repo base-branch override ({ [repoUrl]: branchName }) — lets a caller
  // pick a different base per repo on a multi-repo project. A repo omitted
  // here falls back to `baseBranch`, then to its own actual default branch.
  baseBranches?: Record<string, string>;
  scope?: string;
  // Optional tracker provenance when seeded from a GitHub issue / Jira artifact.
  source?: {
    bindingId: string;
    resourceType?: string;
    resourceId: string;
    resourceUrl?: string;
  };
}

// The structured answer the QuestionEditor produces, matching what the runtime's
// formatResumeAnswer parses. `steering` optionally rides a course correction on
// the answer — injected into the resumed conversation right after it.
export interface GateAnswer {
  status?: 'answered' | 'approved' | 'rejected';
  answer?: unknown;
  steering?: string;
}

// The intent's Neptune knowledge subgraph (GET .../graph): what the run
// produced and drew on. Generic node bags (same shape family as the v1 sprint
// graph) — `type` is the vertex label: Intent | Artifact | Question |
// Discussion | TeamKnowledge | LearningRule, plus the derived layer (Story |
// Requirement | Persona | Component | Decision | StoryMapEntry | Contract |
// UnitOfWork, tagged graphLayer='derived'). Artifact/knowledge nodes carry a
// bounded `contentPreview` (+ `contentLength`), never the full content.
export interface IntentGraphNode {
  id: string;
  type: string;
  label: string;
  // Derived-layer fields (typed items mirrored from artifact structured
  // blocks — docs/v2-granular-graph.md). `artifactId` joins an item back to
  // its source artifact node/card.
  graphLayer?: 'derived';
  slug?: string | null;
  artifactId?: string | null;
  artifactType?: string | null;
  priority?: string | null;
  status?: string | null;
  [key: string]: unknown;
}

export interface IntentGraphEdge {
  source: string;
  target: string;
  // CONTAINS | PRODUCES | CONSUMES | DERIVED_FROM | RELATES_TO | DEPENDS_ON |
  // INFLUENCES | DISCUSSES | INFORMS (synthesized: project knowledge → this run).
  label: string;
}

export interface IntentKnowledgeGraph {
  nodes: IntentGraphNode[];
  edges: IntentGraphEdge[];
}

// Per-intent usage+cost summary within a project rollup.
export interface ProjectIntentMetrics {
  intentId: string;
  title: string | null;
  status: IntentStatus | null;
  metrics: Record<string, number>;
  cost: {
    totalCost: number;
    currency: string;
    priced: boolean;
    estimated?: boolean;
    hasCostedSamples: boolean;
  };
}

// GET /projects/{id}/intents/metrics — usage + cost rolled up across every
// intent. `anyUnpriced` warns that a token-spending intent ran on a model we
// couldn't price (a newer model, or a Kiro run without a captured credit rate);
// `anyEstimated` warns that Kiro credit-estimated dollars are in the total.
export interface ProjectMetrics {
  perIntent: ProjectIntentMetrics[];
  project: {
    metrics: Record<string, number>;
    cost: { totalCost: number; currency: string; anyUnpriced: boolean; anyEstimated?: boolean };
  };
}

// ── Intent audit (GET /projects/{id}/intents/{id}/audit) ──
// Aggregated process evidence for one intent: what the agents READ from the
// graph (the attention ledger), what enrichment cost, and what the sensors
// found — the data for judging whether the graph/enrichment mechanisms are
// paying off. Server shape: lambda/intents/audit.js.
export interface IntentAuditReadTool {
  tool: string;
  calls: number;
  bytes: number;
  resultCount: number;
}

export interface IntentAuditEnrichment {
  /** Enrichment mode this execution ran with (snapshotted at intent create). */
  mode: 'off' | 'llm';
  /** One-shot summary calls made by derive-artifacts. */
  calls: number;
  tokensInput: number;
  tokensOutput: number;
  credits: number;
  /** Compact-read adoption: targeted graph reads vs full-document reads. */
  reads: {
    compactCalls: number;
    compactBytes: number;
    fullCalls: number;
    fullBytes: number;
    /** compactBytes / (compactBytes+fullBytes), 0..1; null with no reads. */
    compactShare: number | null;
  };
}

export interface IntentAuditAdvisory {
  kind: string;
  severity: string;
  summary: string;
  stageInstanceId?: string | null;
}

/** Derivation health + structure-contract compliance for the intent. */
export interface IntentAuditDerivation {
  /** Successful (incl. partial) derive runs. */
  runs: number;
  failures: number;
  partial: number;
  enrichmentSkips: number;
  structuredBlocks: {
    checked: number;
    present: number;
    absent: number;
    malformed: number;
    /** present / checked, 0..1; null when nothing was checked. */
    complianceRate: number | null;
  };
}

/** Per-unit-lane read/spend rollup. */
export interface IntentAuditUnit {
  unitSlug: string;
  readCalls: number;
  readBytes: number;
  tokensInput: number;
  tokensOutput: number;
}

/** Write-side context ledger: what the runtime pushed into fresh stage prompts. */
export interface IntentAuditPromptContext {
  samples: number;
  promptBytes: number;
  compiledContextBytes: number;
  avgPromptBytes: number | null;
}

export interface IntentAudit {
  summary: {
    stageCount: number;
    eventCount: number;
    humanTaskCount: number;
    metricSamples: number;
    graphReadCalls: number;
    graphReadBytes: number;
    sensorRuns: number;
    sensorFindings: number;
  };
  graphReads: { totalBytes: number; byTool: IntentAuditReadTool[] };
  enrichment: IntentAuditEnrichment;
  derivation: IntentAuditDerivation;
  promptContext: IntentAuditPromptContext;
  units: IntentAuditUnit[];
  metrics: { key: string; samples: number; total: number; max: number }[];
  sensors: {
    runs: number;
    findings: {
      sensorId?: string;
      result?: string;
      severity?: string;
      held: boolean;
      stageInstanceId: string | null;
      detail: unknown;
    }[];
  };
  advisories: IntentAuditAdvisory[];
}

export const intentsService = {
  list: (projectId: string, status?: IntentStatus) =>
    api.get<Intent[]>(`/projects/${projectId}/intents${status ? `?status=${status}` : ''}`),
  get: (projectId: string, intentId: string) =>
    api.get<IntentDetail>(`/projects/${projectId}/intents/${intentId}`),
  projectMetrics: (projectId: string) =>
    api.get<ProjectMetrics>(`/projects/${projectId}/intents/metrics`),
  graph: (projectId: string, intentId: string) =>
    api.get<IntentKnowledgeGraph>(`/projects/${projectId}/intents/${intentId}/graph`),
  audit: (projectId: string, intentId: string) =>
    api.get<IntentAudit>(`/projects/${projectId}/intents/${intentId}/audit`),
  // Lazy agent transcript (the detail DTO carries no outputs). `stageInstanceId`
  // scopes to one pane — the literal "intent" is the stage-less workspace/init
  // bucket; `afterSeq` fetches only chunks emitted after a known sequence.
  outputs: (
    projectId: string,
    intentId: string,
    params: { stageInstanceId?: string; afterSeq?: number } = {},
  ) => {
    const qs = new URLSearchParams();
    if (params.stageInstanceId !== undefined) qs.set('stageInstanceId', params.stageInstanceId);
    if (params.afterSeq !== undefined) qs.set('afterSeq', String(params.afterSeq));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return api.get<{ outputs: IntentOutput[] }>(
      `/projects/${projectId}/intents/${intentId}/outputs${suffix}`,
    );
  },
  create: (projectId: string, input: CreateIntentInput) =>
    api.post<Intent>(`/projects/${projectId}/intents`, input),
  start: (projectId: string, intentId: string) =>
    api.post<Intent>(`/projects/${projectId}/intents/${intentId}/start`, {}),
  cancel: (projectId: string, intentId: string) =>
    api.post<Intent>(`/projects/${projectId}/intents/${intentId}/cancel`, {}),
  // Permanent delete: removes the intent's graph data, process state and
  // realtime docs. Owner/admin only; refused (409) while RUNNING.
  delete: (projectId: string, intentId: string) =>
    api.delete(`/projects/${projectId}/intents/${intentId}`),
  // Steering rewind: restart the run from `fromStageId` (409 while RUNNING —
  // wait for the stage to park or finish). Guidance is optional: with it this
  // is a corrective rewind (a steering row the restarted stage consumes);
  // without it, a plain retry of the stage + everything after it.
  rewind: (
    projectId: string,
    intentId: string,
    input: { fromStageId: string; guidance?: string },
  ) =>
    api.post<{ intent: Intent; steering: IntentSteering | null }>(
      `/projects/${projectId}/intents/${intentId}/rewind`,
      input,
    ),
  answerGate: (projectId: string, intentId: string, humanTaskId: string, input: GateAnswer) =>
    api.post<IntentGate>(
      `/projects/${projectId}/intents/${intentId}/gates/${humanTaskId}/answer`,
      input,
    ),
  // Steering revision: correct an already-given answer. Delivered at the next
  // deterministic injection point (`delivery` says which).
  reviseGate: (projectId: string, intentId: string, humanTaskId: string, message: string) =>
    api.post<IntentSteering & { delivery: 'next-resume' | 'next-stage-start' }>(
      `/projects/${projectId}/intents/${intentId}/gates/${humanTaskId}/revise`,
      { message },
    ),
};
