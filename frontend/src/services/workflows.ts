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
  version: number;
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
  pinnedVersion: number | string | null;
  phasePath: string | null;
  order: number;
  scopeMembership: Record<string, 'EXECUTE' | 'SKIP'>;
}

export interface PlacementInput {
  stageId: string;
  stageTenant?: string;
  pinnedVersion?: number | string | null;
  phasePath?: string | null;
  order?: number;
  scopeMembership?: Record<string, 'EXECUTE' | 'SKIP'>;
}

export interface ScopeRef {
  scopeId: string;
  scopeTenant: string;
}

// A rule layered into the workflow. `layer` is V2's resolution chain
// (org → team → team-learnings → project → project-learnings → phase → stage);
// the compiler resolves which stages it applies to (universal layers — incl. the
// two learnings tiers — everywhere, phase rules by matching phase). The
// learnings tiers are accrued by the runtime learning loop and ship empty.
export type RuleLayer =
  | 'org'
  | 'team'
  | 'team-learnings'
  | 'project'
  | 'project-learnings'
  | 'phase'
  | 'stage';

export interface RuleRef {
  ruleId: string;
  layer: RuleLayer;
  ruleTenant: string;
}

// The full composition returned by GET /workflows/{id}.
export interface Workflow extends WorkflowSummary {
  phases: PhaseNode[];
  placements: Placement[];
  scopeRefs: ScopeRef[];
  ruleRefs: RuleRef[];
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
    nodes: {
      stageId: string;
      phasePath: string | null;
      order: number;
      forEach?: string | null;
      execution?: string | null;
      branch?: { forEach: string; supported: boolean; section: number | null } | null;
      section?: number | null;
    }[];
    edges: { from: string; to: string; artifact?: string; kind: 'data' | 'requires' | 'blocks' }[];
    cycles: string[];
    danglingConsumes: { stageId: string; artifact: string }[];
    // `terminal` tags a deliberate end-of-flow output (registered terminal
    // artifact) vs a genuine unwired producer; null when no registry was used.
    orphanProduces: { artifact: string; producedBy: string[]; terminal: boolean | null }[];
    unknownArtifacts: { artifact: string; stageId: string; role: 'produces' | 'consumes' }[];
    acyclic: boolean;
  };
  rules: {
    universal: { ruleId: string; layer: RuleLayer }[];
    phaseRules: Record<string, string[]>;
    pairings: { ruleId: string; sensor: string }[];
    perStage: Record<string, { universal: string[]; phase: string[] }>;
    unresolved: string[];
  };
}

export interface ExecutionPreviewIssue {
  code: string;
  message: string;
  stageId?: string;
  ref?: unknown;
}

export interface ExecutionPreview {
  valid: boolean;
  errors: ExecutionPreviewIssue[];
  warnings: ExecutionPreviewIssue[];
  plan: {
    workflowId: string;
    workflowVersion: number;
    scope: string;
    namespace: string;
    sections: { index: number; stageIds: string[] }[];
    outOfScopeStageIds: string[];
    // Per-intent skip overlay applied to this preview (empty when none).
    skippedStages?: { stageId: string; phase: string | null; stageInstanceId: string }[];
    // Exact run-shape counts (upstream validate-grid `summary`, 2.2.12) — the
    // scope-confirmation UI renders these verbatim ("N of T stages, G approval
    // gates" + per-unit fan-out clause) instead of re-deriving them.
    summary?: {
      executedStages: number;
      totalStages: number;
      approvalGates: number;
      perUnitStages: number;
      skippedStages: number;
      outOfScopeStages: number;
    };
    stages: {
      stageId: string;
      phase?: string | null;
      forEach?: string | null;
      execution?: string | null;
      humanValidation?: string | null;
      parallelSection?: number | null;
      forEachDegraded?: boolean;
      inputArtifacts?: { artifact: string; producedBy?: string[]; expectedAbsent?: boolean }[];
      outputArtifacts?: { artifact: string; terminal?: boolean | null }[];
    }[];
  } | null;
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
  get: (id: string, version?: number) =>
    api.get<Workflow>(`/workflows/${id}${version ? `?version=${version}` : ''}`),
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
  putScopeMembership: (id: string, scopeId: string, stageIds: string[], scopeTenant?: string) =>
    api.put<Workflow>(`/workflows/${id}/scopes/${scopeId}/membership`, {
      stageIds,
      scopeTenant,
    }),

  addRuleRef: (id: string, ruleId: string, layer: RuleLayer, ruleTenant?: string) =>
    api.post<RuleRef>(`/workflows/${id}/rules`, { ruleId, layer, ruleTenant }),
  removeRuleRef: (id: string, layer: RuleLayer, ruleId: string) =>
    api.delete(`/workflows/${id}/rules/${layer}/${ruleId}`),

  // The derived scope-grid + autonomy + stage-graph for this workflow.
  compiled: (id: string, version?: number) =>
    api.get<CompiledWorkflow>(`/workflows/${id}/compiled${version ? `?version=${version}` : ''}`),
  executionPreview: (id: string, scope: string, version?: number, skipStageIds?: string[]) => {
    const params = new URLSearchParams({ scope });
    if (version) params.set('version', String(version));
    // Dry-run a per-intent stage deselection: the preview applies the skip
    // overlay and returns the resulting warnings (expected-absent inputs,
    // degraded sections) before any intent exists.
    if (skipStageIds?.length) params.set('skip', skipStageIds.join(','));
    return api.get<ExecutionPreview>(`/workflows/${id}/execution-preview?${params.toString()}`);
  },
};
