import { api } from './api';

// Workflows — the composition roots that reference and arrange library blocks.
// A workflow has a grouping tree (define-your-own, nestable phases) and skill
// placements (the workflow × skill join). Mirrors lambda/workflows.

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

// A node in the grouping tree. Ordering and nesting are encoded in `path`
// (e.g. "01", "01.02"); `parentPath`/`order` are derived from it server-side.
export interface GroupingNode {
  groupingId: string;
  groupingTenant: string;
  kind: string;
  path: string;
  parentPath: string | null;
  order: number;
}

// A node as posted to PUT /groupings — only groupingId + path are required.
export interface GroupingNodeInput {
  groupingId: string;
  path: string;
  kind?: string;
  groupingTenant?: string;
}

export interface Placement {
  skillId: string;
  skillTenant: string;
  pinnedVersion: string | null;
  groupingPath: string | null;
  order: number;
  scopeMembership: Record<string, 'EXECUTE' | 'SKIP'>;
}

export interface PlacementInput {
  skillId: string;
  skillTenant?: string;
  pinnedVersion?: string | null;
  groupingPath?: string | null;
  order?: number;
  scopeMembership?: Record<string, 'EXECUTE' | 'SKIP'>;
}

// The full composition returned by GET /workflows/{id}.
export interface Workflow extends WorkflowSummary {
  groupings: GroupingNode[];
  placements: Placement[];
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
  putGroupings: (id: string, groupings: GroupingNodeInput[]) =>
    api.put<Workflow>(`/workflows/${id}/groupings`, { groupings }),

  addPlacement: (id: string, input: PlacementInput) =>
    api.post<Placement>(`/workflows/${id}/placements`, input),
  updatePlacement: (id: string, skillId: string, input: Partial<PlacementInput>) =>
    api.put<Placement>(`/workflows/${id}/placements/${skillId}`, input),
  removePlacement: (id: string, skillId: string) =>
    api.delete(`/workflows/${id}/placements/${skillId}`),
};
