import { api } from './api';

export type ProjectRole = 'owner' | 'admin' | 'member';
export type AgentCli = 'kiro' | 'claude' | 'opencode';
export type RepoRole = 'primary' | 'frontend' | 'backend' | 'api' | 'infra' | 'shared' | 'docs' | 'unknown';

export interface ProjectRepo {
  url: string;
  provider: 'github' | 'gitlab';
  role: RepoRole;
  detectedStack: string;
  addedAt: string;
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
  repos?: ProjectRepo[];
}

export interface CreateProjectInput {
  name: string;
  gitProvider: 'github' | 'gitlab';
  gitRepo: string;
  agentCli?: AgentCli;
  issueIntegrationEnabled?: boolean;
  repos?: { url: string; provider?: string; role?: RepoRole }[];
}

export interface UpdateProjectInput {
  name?: string;
  gitRepo?: string;
  gitProvider?: 'github' | 'gitlab';
  agentCli?: AgentCli;
  issueIntegrationEnabled?: boolean;
}

export interface AddRepoInput {
  url: string;
  provider?: 'github' | 'gitlab';
  role?: RepoRole;
  detectedStack?: string;
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

  // Repos
  listRepos: (projectId: string) => api.get<ProjectRepo[]>(`/projects/${projectId}/repos`),
  addRepo: (projectId: string, input: AddRepoInput) =>
    api.post<ProjectRepo>(`/projects/${projectId}/repos`, input),
  removeRepo: (projectId: string, repoUrl: string) =>
    api.delete(`/projects/${projectId}/repos?url=${encodeURIComponent(repoUrl)}`),

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
