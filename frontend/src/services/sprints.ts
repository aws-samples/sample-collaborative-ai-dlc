import { api } from './api';

export type SprintPhase = 'INCEPTION' | 'CONSTRUCTION' | 'REVIEW';
export type AgentStatus = 'running' | 'waiting' | 'completed' | 'failed' | 'cancelled' | null;

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
}

export const sprintsService = {
  list: (projectId: string) => api.get<Sprint[]>(`/projects/${projectId}/sprints`),
  get: (projectId: string, sprintId: string) => api.get<Sprint>(`/projects/${projectId}/sprints/${sprintId}`),
  create: (projectId: string, input: { name: string; description?: string }) => api.post<Sprint>(`/projects/${projectId}/sprints`, input),
  update: (projectId: string, sprintId: string, input: Partial<Sprint>) => api.put<Sprint>(`/projects/${projectId}/sprints/${sprintId}`, input),
  delete: (projectId: string, sprintId: string) => api.delete(`/projects/${projectId}/sprints/${sprintId}`),
};
