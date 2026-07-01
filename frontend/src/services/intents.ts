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
  status: 'pending' | 'answered' | 'approved' | 'rejected';
  prompt: string | null;
  options: unknown;
  questions: string | null;
  answer: unknown;
  answeredBy: string | null;
  answeredAt: string | null;
  createdAt: string | null;
}

export interface IntentMetric {
  metricId: string;
  stageInstanceId: string | null;
  metrics: Record<string, number>;
  timestamp: string;
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
  timestamp: string;
}

export interface IntentArtifact {
  id: string;
  artifactType: string | null;
  title: string | null;
  createdByExecutionId: string | null;
  createdByStageInstanceId: string | null;
  createdAt: string | null;
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
}

// The assembled detail returned by GET /projects/{id}/intents/{intentId}.
export interface IntentDetail {
  intent: Intent;
  stages: IntentStage[];
  events: IntentActivityEvent[];
  gates: IntentGate[];
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
// formatResumeAnswer parses.
export interface GateAnswer {
  status?: 'answered' | 'approved' | 'rejected';
  answer?: unknown;
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
  // DISCUSSES | INFORMS (synthesized: project knowledge → this run).
  label: string;
}

export interface IntentKnowledgeGraph {
  nodes: IntentGraphNode[];
  edges: IntentGraphEdge[];
}

export const intentsService = {
  list: (projectId: string, status?: IntentStatus) =>
    api.get<Intent[]>(`/projects/${projectId}/intents${status ? `?status=${status}` : ''}`),
  get: (projectId: string, intentId: string) =>
    api.get<IntentDetail>(`/projects/${projectId}/intents/${intentId}`),
  graph: (projectId: string, intentId: string) =>
    api.get<IntentKnowledgeGraph>(`/projects/${projectId}/intents/${intentId}/graph`),
  create: (projectId: string, input: CreateIntentInput) =>
    api.post<Intent>(`/projects/${projectId}/intents`, input),
  start: (projectId: string, intentId: string) =>
    api.post<Intent>(`/projects/${projectId}/intents/${intentId}/start`, {}),
  answerGate: (projectId: string, intentId: string, humanTaskId: string, input: GateAnswer) =>
    api.post<IntentGate>(
      `/projects/${projectId}/intents/${intentId}/gates/${humanTaskId}/answer`,
      input,
    ),
};
