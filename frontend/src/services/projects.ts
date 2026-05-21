import { api } from './api';

export type ProjectRole = 'owner' | 'admin' | 'member';
export type AgentCli = 'kiro' | 'claude' | 'opencode';

export interface Project {
  id: string;
  name: string;
  gitProvider: 'github' | 'gitlab';
  gitRepo: string;
  agentCli: AgentCli;
  issueIntegrationEnabled?: boolean;
  createdAt: string;
  userRole?: ProjectRole;
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
};
