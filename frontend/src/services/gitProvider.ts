import { api } from './api';

// =============================================================================
// Shared types — provider-agnostic shapes returned by both GitHub and GitLab.
// =============================================================================

export interface GitRepo {
  id: number;
  name: string;
  fullName: string;
  private: boolean;
  defaultBranch: string;
}

export interface GitProviderStatus {
  connected: boolean;
  provider?: string;
}

export interface GitFile {
  path: string;
  sha: string;
  size: number;
}

export interface GitFileContent {
  path: string;
  sha: string;
  size: number;
  content: string;
}

export interface GitComment {
  id: number;
  type: 'review' | 'issue';
  body: string;
  user: { login: string; avatarUrl: string };
  path: string | null;
  line: number | null;
  createdAt: string;
  updatedAt: string;
}

// =============================================================================
// Provider service interface — implemented by both GitHub and GitLab services.
// =============================================================================

export interface GitProviderService {
  getAuthUrl: () => Promise<{ url: string }>;
  getStatus: () => Promise<GitProviderStatus>;
  listRepos: () => Promise<GitRepo[]>;
  listBranches: (...args: string[]) => Promise<{ branches: string[] }>;
  disconnect: () => Promise<unknown>;
  getRepoTree: (repoId: string, branch?: string) => Promise<{ tree: GitFile[] }>;
  getFileContents: (repoId: string, path: string, branch?: string) => Promise<GitFileContent>;
}

// =============================================================================
// GitHub service implementation
// =============================================================================

export const githubService: GitProviderService & {
  listBranches: (owner: string, repo: string) => Promise<{ branches: string[] }>;
  getRepoTree: (owner: string, repo: string, branch?: string) => Promise<{ tree: GitFile[] }>;
  getFileContents: (
    owner: string,
    repo: string,
    path: string,
    branch?: string,
  ) => Promise<GitFileContent>;
  getPRComments: (
    owner: string,
    repo: string,
    prNumber: number,
  ) => Promise<{ comments: GitComment[] }>;
  addPRComment: (
    owner: string,
    repo: string,
    prNumber: number,
    comment: { body: string; path?: string; line?: number; side?: string },
  ) => Promise<{ id: number; body: string; createdAt: string }>;
} = {
  getAuthUrl: () => api.get<{ url: string }>('/github/auth'),
  getStatus: () => api.get<GitProviderStatus>('/github/status'),
  listRepos: () => api.get<GitRepo[]>('/github/repos'),
  listBranches: (owner: string, repo: string) =>
    api.get<{ branches: string[] }>(`/github/repos/${owner}/${repo}/branches`),
  disconnect: () => api.delete('/github/disconnect'),
  getRepoTree: (owner: string, repo?: string, branch?: string) =>
    api.get<{ tree: GitFile[] }>(
      `/github/repos/${owner}/${repo}/tree${branch ? `?branch=${branch}` : ''}`,
    ),
  getFileContents: (owner: string, repo?: string, path?: string, branch?: string) =>
    api.get<GitFileContent>(
      `/github/repos/${owner}/${repo}/contents?path=${encodeURIComponent(path!)}${branch ? `&branch=${branch}` : ''}`,
    ),
  getPRComments: (owner: string, repo: string, prNumber: number) =>
    api.get<{ comments: GitComment[] }>(
      `/github/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    ),
  addPRComment: (
    owner: string,
    repo: string,
    prNumber: number,
    comment: { body: string; path?: string; line?: number; side?: string },
  ) =>
    api.post<{ id: number; body: string; createdAt: string }>(
      `/github/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
      comment,
    ),
};

// =============================================================================
// GitLab service implementation
// =============================================================================

export const gitlabService: GitProviderService & {
  listBranches: (projectId: string) => Promise<{ branches: string[] }>;
  getRepoTree: (projectId: string, branch?: string) => Promise<{ tree: GitFile[] }>;
  getFileContents: (projectId: string, path: string, branch?: string) => Promise<GitFileContent>;
  getMRComments: (projectId: string, mrIid: number) => Promise<{ comments: GitComment[] }>;
  addMRComment: (
    projectId: string,
    mrIid: number,
    comment: { body: string; path?: string; line?: number },
  ) => Promise<{ id: number; body: string; createdAt: string }>;
} = {
  getAuthUrl: () => api.get<{ url: string }>('/gitlab/auth'),
  getStatus: () => api.get<GitProviderStatus>('/gitlab/status'),
  listRepos: () => api.get<GitRepo[]>('/gitlab/repos'),
  listBranches: (projectId: string) =>
    api.get<{ branches: string[] }>(`/gitlab/projects/${encodeURIComponent(projectId)}/branches`),
  disconnect: () => api.delete('/gitlab/disconnect'),
  getRepoTree: (projectId: string, branch?: string) =>
    api.get<{ tree: GitFile[] }>(
      `/gitlab/projects/${encodeURIComponent(projectId)}/tree${branch ? `?branch=${branch}` : ''}`,
    ),
  getFileContents: (projectId: string, path: string, branch?: string) =>
    api.get<GitFileContent>(
      `/gitlab/projects/${encodeURIComponent(projectId)}/contents?path=${encodeURIComponent(path)}${branch ? `&branch=${branch}` : ''}`,
    ),
  getMRComments: (projectId: string, mrIid: number) =>
    api.get<{ comments: GitComment[] }>(
      `/gitlab/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`,
    ),
  addMRComment: (
    projectId: string,
    mrIid: number,
    comment: { body: string; path?: string; line?: number },
  ) =>
    api.post<{ id: number; body: string; createdAt: string }>(
      `/gitlab/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`,
      comment,
    ),
};

// =============================================================================
// Provider lookup — given a `gitProvider` field, return the matching service.
// =============================================================================

export const getGitProviderService = (provider: 'github' | 'gitlab'): GitProviderService => {
  return provider === 'gitlab' ? gitlabService : githubService;
};
