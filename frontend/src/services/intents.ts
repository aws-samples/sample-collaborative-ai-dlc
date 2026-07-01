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
  source: IntentSource | null;
  createdAt: string | null;
  updatedAt: string | null;
  completedAt: string | null;
}

export interface IntentStage {
  stageInstanceId: string;
  stageId: string | null;
  phase: string | null;
  state: StageState;
  attempt: number;
  cli: string | null;
  runtimeError: string | null;
  startedAt: string | null;
  completedAt: string | null;
  updatedAt: string | null;
}

// A human gate (HUMAN# row). `questions` is the v1-shaped structured-questions
// JSON string when kind === 'question' — parsed into the QuestionEditor shape
// by the IntentView.
export interface IntentGate {
  humanTaskId: string;
  stageInstanceId: string | null;
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
// (a newer model, or a Kiro credit-based run) — the UI shows "cost unavailable"
// rather than a misleading $0.
export interface MetricCost {
  model: string | null;
  currency: string;
  inputCost: number;
  outputCost: number;
  totalCost: number;
  priced: boolean;
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
  kind: string;
  content: string;
  timestamp: string;
}

export interface IntentSensorRun {
  sensorRunId: string;
  stageInstanceId: string | null;
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
}

export interface CreateIntentInput {
  title?: string;
  prompt?: string;
  branch?: string;
  baseBranch?: string;
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
// Discussion | TeamKnowledge | LearningRule. Artifact/knowledge nodes carry a
// bounded `contentPreview` (+ `contentLength`), never the full content.
export interface IntentGraphNode {
  id: string;
  type: string;
  label: string;
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
  cost: { totalCost: number; currency: string; priced: boolean; hasCostedSamples: boolean };
}

// GET /projects/{id}/intents/metrics — usage + cost rolled up across every
// intent. `anyUnpriced` warns that a token-spending intent ran on a model we
// couldn't price (a newer model, or a Kiro credit-based run).
export interface ProjectMetrics {
  perIntent: ProjectIntentMetrics[];
  project: {
    metrics: Record<string, number>;
    cost: { totalCost: number; currency: string; anyUnpriced: boolean };
  };
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
  create: (projectId: string, input: CreateIntentInput) =>
    api.post<Intent>(`/projects/${projectId}/intents`, input),
  start: (projectId: string, intentId: string) =>
    api.post<Intent>(`/projects/${projectId}/intents/${intentId}/start`, {}),
  cancel: (projectId: string, intentId: string) =>
    api.post<Intent>(`/projects/${projectId}/intents/${intentId}/cancel`, {}),
  // Steering rewind: restart the run from `fromStageId` with corrective
  // guidance (409 while RUNNING — wait for the stage to park or finish).
  rewind: (projectId: string, intentId: string, input: { fromStageId: string; guidance: string }) =>
    api.post<{ intent: Intent; steering: IntentSteering }>(
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
