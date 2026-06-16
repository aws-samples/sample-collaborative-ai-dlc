import { api } from './api';

// Workflows — the composition roots that reference and arrange library blocks.
// A workflow has a phase tree (define-your-own, nestable, inline) and stage
// placements (the workflow × stage join). Mirrors lambda/workflows.

export interface WorkflowSummary {
  id: string;
  workflowId: string;
  name: string;
  objective: string;
  owner: string;
  basedOn: string | null;
  defaultScope: string | null;
  status: string;
  readOnly: boolean;
  createdAt: string;
  updatedAt: string;
}

// A node in the phase tree, defined inline (no library reference). Ordering and
// nesting are encoded in `path` (e.g. "01", "01.02"); `parentPath`/`order` are
// derived from it server-side.
export interface PhaseNode {
  phaseId: string;
  name: string;
  kind: string;
  path: string;
  parentPath: string | null;
  order: number;
}

// A node as posted to PUT /phases — only phaseId + path are required.
export interface PhaseNodeInput {
  phaseId: string;
  path: string;
  name?: string;
  kind?: string;
}

export interface Placement {
  stageId: string;
  stageTenant: string;
  pinnedVersion: string | null;
  phasePath: string | null;
  order: number;
  scopeMembership: Record<string, 'EXECUTE' | 'SKIP'>;
}

export interface PlacementInput {
  stageId: string;
  stageTenant?: string;
  pinnedVersion?: string | null;
  phasePath?: string | null;
  order?: number;
  scopeMembership?: Record<string, 'EXECUTE' | 'SKIP'>;
}

export interface ScopeRef {
  scopeId: string;
  scopeTenant: string;
}

// The full composition returned by GET /workflows/{id}.
export interface Workflow extends WorkflowSummary {
  phases: PhaseNode[];
  placements: Placement[];
  scopeRefs: ScopeRef[];
}

export type AutonomyLevel = 'self-halting' | 'mixed' | 'human-gated';

// The derived views returned by GET /workflows/{id}/compiled.
export interface CompiledWorkflow {
  scopeGrid: Record<string, Record<string, 'EXECUTE' | 'SKIP'>>;
  autonomy: {
    perStage: Record<string, AutonomyLevel>;
    rollup: { selfHalting: number; mixed: number; humanGated: number; total: number };
  };
  graph: {
    nodes: { stageId: string; phasePath: string | null; order: number }[];
    edges: { from: string; to: string; artifact?: string; kind: 'data' | 'requires' }[];
    cycles: string[];
    danglingConsumes: { stageId: string; artifact: string }[];
    orphanProduces: { artifact: string; producedBy: string[] }[];
    acyclic: boolean;
  };
}

export interface CreateWorkflowInput {
  id: string;
  name: string;
  objective?: string;
  basedOn?: string;
  defaultScope?: string;
}

export interface UpdateWorkflowInput {
  name?: string;
  objective?: string;
  defaultScope?: string;
  status?: string;
}

export const workflowsService = {
  list: () => api.get<{ workflows: WorkflowSummary[] }>('/workflows'),
  get: (id: string) => api.get<Workflow>(`/workflows/${id}`),
  create: (input: CreateWorkflowInput) => api.post<WorkflowSummary>('/workflows', input),
  update: (id: string, input: UpdateWorkflowInput) =>
    api.put<WorkflowSummary>(`/workflows/${id}`, input),
  delete: (id: string) => api.delete(`/workflows/${id}`),

  // Whole-tree replace — send the full ordered, nestable node list.
  putPhases: (id: string, phases: PhaseNodeInput[]) =>
    api.put<Workflow>(`/workflows/${id}/phases`, { phases }),

  addPlacement: (id: string, input: PlacementInput) =>
    api.post<Placement>(`/workflows/${id}/placements`, input),
  updatePlacement: (id: string, stageId: string, input: Partial<PlacementInput>) =>
    api.put<Placement>(`/workflows/${id}/placements/${stageId}`, input),
  removePlacement: (id: string, stageId: string) =>
    api.delete(`/workflows/${id}/placements/${stageId}`),

  addScopeRef: (id: string, scopeId: string, scopeTenant?: string) =>
    api.post<ScopeRef>(`/workflows/${id}/scopes`, { scopeId, scopeTenant }),
  removeScopeRef: (id: string, scopeId: string) => api.delete(`/workflows/${id}/scopes/${scopeId}`),

  // The derived scope-grid + autonomy + stage-graph for this workflow.
  compiled: (id: string) => api.get<CompiledWorkflow>(`/workflows/${id}/compiled`),
};
