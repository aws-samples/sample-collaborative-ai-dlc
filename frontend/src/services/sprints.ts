import { api } from './api';

export type SprintPhase = 'INCEPTION' | 'CONSTRUCTION' | 'REVIEW';
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | null;

// Polymorphic link from a Sprint to the tracker resource it was started from.
// Replaces the old GitHub-only `issueNumber`/`issueUrl` pair on writes; both
// shapes still surface on reads for legacy / unmigrated data.
export interface SprintTracker {
  provider: string;
  instance: string | null;
  externalProjectKey: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceUrl: string | null;
}

export interface CreateSprintTrackerInput {
  bindingId?: string;
  provider?: string;
  instance?: string;
  externalProjectKey?: string;
  resourceType?: 'issue';
  resourceId: string;
  resourceUrl: string;
}

export interface Sprint {
  id: string;
  name: string;
  description: string;
  phase: SprintPhase;
  createdAt: string;
  // Agent state fields (Phase 1 & 2)
  currentExecutionArn: string | null;
  currentExecutionId: string | null;
  currentAgentType: string | null;
  currentAgentStatus: AgentStatus;
  agentStartedAt: string | null;
  agentCompletedAt: string | null;
  // PR fields
  prUrl: string | null;
  prNumber: string | null;
  // Branch fields (persisted after first construction kick-off)
  branch: string | null;
  baseBranch: string | null;
  // Tracker link — polymorphic across providers (#194). null when the sprint
  // wasn't started from a tracker resource.
  tracker: SprintTracker | null;
  // Legacy fields kept on read for unmigrated sprints. New writes populate
  // `tracker`; the backend mirrors github-issues into these on output.
  issueNumber: string | null;
  issueUrl: string | null;
}

export interface CreateSprintInput {
  name: string;
  description?: string;
  tracker?: CreateSprintTrackerInput;
}

export const sprintsService = {
  list: (projectId: string) => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
  get: (projectId: string, sprintId: string) =>
    api.get<Sprint>(`/projects/${projectId}/sprints/${sprintId}`),
  create: (projectId: string, input: CreateSprintInput) =>
    api.post<Sprint>(`/projects/${projectId}/sprints`, input),
  update: (projectId: string, sprintId: string, input: Partial<Sprint>) =>
    api.put<Sprint>(`/projects/${projectId}/sprints/${sprintId}`, input),
  delete: (projectId: string, sprintId: string) =>
    api.delete(`/projects/${projectId}/sprints/${sprintId}`),
};
