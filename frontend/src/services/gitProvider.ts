import { api } from './api';

// =============================================================================
// Shared types — provider-agnostic shapes returned by both GitHub and GitLab.
// =============================================================================

// The set of supported git providers. Kept as a string-literal union (not a TS
// enum) because the values are wire strings sent to/from the API and stored in
// the DB — a union assigns directly from those strings with zero runtime cost.
export type GitProvider = 'github' | 'gitlab';

// A git provider and its issue-tracker share one OAuth app/connection, so each
// git provider maps to exactly one tracker-provider id. Centralized here so the
// association lives in one place instead of being re-derived with inline
// ternaries at every call site.
export type GitTrackerProviderId = 'github-issues' | 'gitlab-issues';

const GIT_PROVIDER_TRACKER_ID: Record<GitProvider, GitTrackerProviderId> = {
  github: 'github-issues',
  gitlab: 'gitlab-issues',
};

export const trackerIdForGitProvider = (provider: GitProvider): GitTrackerProviderId =>
  GIT_PROVIDER_TRACKER_ID[provider];

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
  // GitLab project paths are namespaced (group/project, often deeper). Encoded
  // slashes in an API Gateway path segment are fragile, so the project ref is
  // sent as a `?project=` query string instead of a path segment. The backend
  // re-encodes it into the GitLab API path (GitLab's required format).
  listBranches: (projectId: string) =>
    api.get<{ branches: string[] }>(
      `/gitlab/projects/branches?project=${encodeURIComponent(projectId)}`,
    ),
  disconnect: () => api.delete('/gitlab/disconnect'),
  getRepoTree: (projectId: string, branch?: string) =>
    api.get<{ tree: GitFile[] }>(
      `/gitlab/projects/tree?project=${encodeURIComponent(projectId)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`,
    ),
  getFileContents: (projectId: string, path: string, branch?: string) =>
    api.get<GitFileContent>(
      `/gitlab/projects/contents?project=${encodeURIComponent(projectId)}&path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`,
    ),
  getMRComments: (projectId: string, mrIid: number) =>
    api.get<{ comments: GitComment[] }>(
      `/gitlab/projects/merge_requests/${mrIid}/notes?project=${encodeURIComponent(projectId)}`,
    ),
  addMRComment: (
    projectId: string,
    mrIid: number,
    comment: { body: string; path?: string; line?: number },
  ) =>
    api.post<{ id: number; body: string; createdAt: string }>(
      `/gitlab/projects/merge_requests/${mrIid}/notes?project=${encodeURIComponent(projectId)}`,
      comment,
    ),
};

// =============================================================================
// Provider lookup — given a `gitProvider` field, return the matching service.
// =============================================================================

export const getGitProviderService = (provider: GitProvider): GitProviderService => {
  return provider === 'gitlab' ? gitlabService : githubService;
};
