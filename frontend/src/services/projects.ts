import { api } from './api';

export type ProjectRole = 'owner' | 'admin' | 'member';
export type AgentCli = 'kiro' | 'claude' | 'opencode';

// One project ↔ tracker (Jira / GitHub Issues / …) binding. Phase 1 of #194
// only writes synthetic GitHub-issues bindings via the migration; Phase 3
// adds Jira and the connect/select UI.
export interface TrackerBinding {
  id: string;
  provider: string;
  instance: string | null;
  externalProjectKey: string | null;
  displayName: string | null;
  createdAt: string | null;
  createdBy: string | null;
}

export interface Project {
  id: string;
  name: string;
  gitProvider: 'github' | 'gitlab';
  gitRepo: string;
  agentCli: AgentCli;
  issueIntegrationEnabled?: boolean;
  createdAt: string;
  userRole?: ProjectRole;
  trackers?: TrackerBinding[];
}

export interface TrackerMigrationResult {
  dryRun: boolean;
  projects: { candidates: number; applied: number };
  sprints: { candidates: number; applied: number };
}

export interface CreateProjectInput {
  name: string;
  gitProvider: 'github' | 'gitlab';
  gitRepo: string;
  agentCli?: AgentCli;
  issueIntegrationEnabled?: boolean;
}

export interface UpdateProjectInput {
  name?: string;
  gitRepo?: string;
  gitProvider?: 'github' | 'gitlab';
  agentCli?: AgentCli;
  issueIntegrationEnabled?: boolean;
}

export interface Member {
  userId: string;
  email?: string;
  role: ProjectRole;
}

export interface AddMemberInput {
  userId: string;
  email?: string;
  role: ProjectRole;
}

export interface CognitoUser {
  userId: string;
  email: string;
  displayName: string;
  enabled: boolean;
  status: string;
}

export const projectsService = {
  list: () => api.get<Project[]>('/projects'),
  get: (id: string) => api.get<Project>(`/projects/${id}`),
  create: (input: CreateProjectInput) => api.post<Project>('/projects', input),
  update: (id: string, input: UpdateProjectInput) => api.put<Project>(`/projects/${id}`, input),
  delete: (id: string) => api.delete(`/projects/${id}`),

  // Members
  listMembers: (projectId: string) => api.get<Member[]>(`/projects/${projectId}/members`),
  addMember: (projectId: string, input: AddMemberInput) =>
    api.post<Member>(`/projects/${projectId}/members`, input),
  updateMemberRole: (projectId: string, userId: string, role: ProjectRole) =>
    api.put<Member>(`/projects/${projectId}/members/${userId}`, { role }),
  removeMember: (projectId: string, userId: string) =>
    api.delete(`/projects/${projectId}/members/${userId}`),

  // Cognito users
  listCognitoUsers: () => api.get<CognitoUser[]>('/users'),

  // Tracker abstraction migration (#194 Phase 1). Owner/admin only. Idempotent.
  migrateTracker: (projectId: string, dryRun = false) =>
    api.post<TrackerMigrationResult>(`/projects/${projectId}/migrate-tracker`, { dryRun }),
};
