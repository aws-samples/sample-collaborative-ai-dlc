import { api } from './api';

export type ProjectRole = 'owner' | 'admin' | 'member';
export type AgentCli = 'kiro' | 'claude' | 'opencode';
export type RepoRole =
  | 'primary'
  | 'secondary'
  | 'frontend'
  | 'backend'
  | 'api'
  | 'infra'
  | 'shared'
  | 'docs'
  | 'unknown';

export interface ProjectRepo {
  url: string;
  provider: 'github' | 'gitlab';
  role: RepoRole;
  detectedStack: string;
  addedAt: string;
}

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
  trackers: TrackerBinding[];
  repos?: ProjectRepo[];
}

export interface TrackerMigrationResult {
  dryRun: boolean;
  projects: { candidates: number; applied: number };
  sprints: { candidates: number; applied: number };
}

// Whole-graph dry-run shape returned by /admin/tracker-migration/status.
// Same wire shape as TrackerMigrationResult — `applied` is always 0 because
// the status endpoint never mutates.
export type TrackerMigrationStatus = TrackerMigrationResult;

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

export interface SteeringDoc {
  filename: string;
  s3Key: string;
  downloadUrl?: string;
  uploadUrl?: string;
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

  // Tracker abstraction migration (#194 Phase 1). Owner/admin only. Idempotent.
  migrateTracker: (projectId: string, dryRun = false) =>
    api.post<TrackerMigrationResult>(`/projects/${projectId}/migrate-tracker`, { dryRun }),

  // Whole-graph admin counterparts of /projects/{id}/migrate-tracker.
  // Authenticated-only — drives the Admin page's Tracker Migration card and
  // shares the same shared core as the per-project endpoint and the bulk CLI
  // lambda. Idempotent. See parent issue #194 phase #198.
  getTrackerMigrationStatus: () =>
    api.get<TrackerMigrationStatus>('/admin/tracker-migration/status'),
  runTrackerMigration: (dryRun = false) =>
    api.post<TrackerMigrationResult>('/admin/tracker-migration', { dryRun }),

  // Project-level MCP servers (raw JSON string)
  getMcpServers: (projectId: string) =>
    api.get<{ mcpServers: string }>(`/projects/${projectId}/mcp-servers`),
  updateMcpServers: (projectId: string, mcpServers: string) =>
    api.put<{ saved: boolean }>(`/projects/${projectId}/mcp-servers`, { mcpServers }),

  // Project-level steering docs
  getSteeringDocs: (projectId: string) =>
    api.get<{ steeringDocs: SteeringDoc[] }>(`/projects/${projectId}/steering-docs`),
  updateSteeringDocs: (projectId: string, steeringDocs: Array<{ filename: string }>) =>
    api.put<{
      saved: boolean;
      uploadUrls: Array<{ filename: string; s3Key: string; uploadUrl: string }>;
    }>(`/projects/${projectId}/steering-docs`, { steeringDocs }),
};
