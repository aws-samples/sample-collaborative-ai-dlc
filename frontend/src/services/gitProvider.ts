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

// Platform-wide GitHub auth mode (admin-managed): 'oauth' = per-user OAuth
// connections; 'app' = GitHub App installation tokens (no per-user connect).
export type GitHubAuthMode = 'oauth' | 'app';

export interface GitProviderStatus {
  connected: boolean;
  provider?: string;
  reauthorizationRequired?: boolean;
  missingScopes?: string[];
  configurationRequired?: boolean;
  configurationError?: string;
  // Present for GitHub (and defaulted to 'oauth' for GitLab). In 'app' mode
  // the connect/disconnect UI is hidden — the platform authenticates as the
  // GitHub App installation.
  mode?: GitHubAuthMode;
}

// Admin-only GitHub integration config (GET/PUT /github/admin/config,
// platform-admin gated on the backend).
export interface GitHubAdminConfig {
  mode: GitHubAuthMode;
  appId: string | null;
  installationId: string | null;
  privateKeySet: boolean;
  appConfigured: boolean;
  appConfigurationError?: string;
  // Returned by PUT when the live installation probe ran successfully.
  installationAccount?: string;
}

export interface GitHubAdminConfigUpdate {
  mode?: GitHubAuthMode;
  appId?: string;
  installationId?: string;
  privateKey?: string;
}

export const githubAdminService = {
  getConfig: () => api.get<GitHubAdminConfig>('/github/admin/config'),
  updateConfig: (update: GitHubAdminConfigUpdate) =>
    api.put<GitHubAdminConfig>('/github/admin/config', update),
};

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
// Provider service interface — implemented by both GitHub and GitLab.
//
// Every method takes the repo's canonical `repoId` (its fullName: "owner/repo"
// for GitHub, "group/project" — possibly nested — for GitLab). Each service
// adapts the repoId to its own URL shape internally, so callers stay
// provider-agnostic and never split owner/repo or build provider URLs.
// =============================================================================

export interface GitProviderService {
  getAuthUrl: () => Promise<{ url: string }>;
  getStatus: () => Promise<GitProviderStatus>;
  listRepos: () => Promise<GitRepo[]>;
  disconnect: () => Promise<unknown>;
  // `defaultBranch` (best-effort — omitted if the provider lookup failed) is
  // the repo's ACTUAL default branch, for preselecting a base-branch picker
  // instead of assuming 'main'.
  listBranches: (repoId: string) => Promise<{ branches: string[]; defaultBranch?: string }>;
  getRepoTree: (repoId: string, branch?: string) => Promise<{ tree: GitFile[] }>;
  getFileContents: (repoId: string, path: string, branch?: string) => Promise<GitFileContent>;
  // PR (GitHub) / MR (GitLab) comments — read-only in the UI (ReviewPage
  // displays them). prNumber is the GitHub PR number or the GitLab MR iid.
  getPullRequestComments: (repoId: string, prNumber: number) => Promise<{ comments: GitComment[] }>;
}

// =============================================================================
// GitHub service implementation — splits the "owner/repo" repoId into the
// two path segments the GitHub routes expect.
// =============================================================================

const splitOwnerRepo = (repoId: string): [string, string] => {
  const [owner, repo] = repoId.split('/');
  return [owner, repo];
};

export const githubService: GitProviderService = {
  getAuthUrl: () => api.get<{ url: string }>('/github/auth'),
  getStatus: () => api.get<GitProviderStatus>('/github/status'),
  listRepos: () => api.get<GitRepo[]>('/github/repos'),
  disconnect: () => api.delete('/github/disconnect'),
  listBranches: (repoId: string) => {
    const [owner, repo] = splitOwnerRepo(repoId);
    return api.get<{ branches: string[]; defaultBranch?: string }>(
      `/github/repos/${owner}/${repo}/branches`,
    );
  },
  getRepoTree: (repoId: string, branch?: string) => {
    const [owner, repo] = splitOwnerRepo(repoId);
    return api.get<{ tree: GitFile[] }>(
      `/github/repos/${owner}/${repo}/tree${branch ? `?branch=${branch}` : ''}`,
    );
  },
  getFileContents: (repoId: string, path: string, branch?: string) => {
    const [owner, repo] = splitOwnerRepo(repoId);
    return api.get<GitFileContent>(
      `/github/repos/${owner}/${repo}/contents?path=${encodeURIComponent(path)}${branch ? `&branch=${branch}` : ''}`,
    );
  },
  getPullRequestComments: (repoId: string, prNumber: number) => {
    const [owner, repo] = splitOwnerRepo(repoId);
    return api.get<{ comments: GitComment[] }>(
      `/github/repos/${owner}/${repo}/pulls/${prNumber}/comments`,
    );
  },
};

// =============================================================================
// GitLab service implementation — GitLab project paths are namespaced
// (group/project, often deeper). Encoded slashes in an API Gateway path
// segment are fragile, so the repoId travels as a `?project=` query string;
// the backend re-encodes it into the GitLab API path.
// =============================================================================

export const gitlabService: GitProviderService = {
  getAuthUrl: () => api.get<{ url: string }>('/gitlab/auth'),
  getStatus: () => api.get<GitProviderStatus>('/gitlab/status'),
  listRepos: () => api.get<GitRepo[]>('/gitlab/repos'),
  disconnect: () => api.delete('/gitlab/disconnect'),
  listBranches: (repoId: string) =>
    api.get<{ branches: string[]; defaultBranch?: string }>(
      `/gitlab/projects/branches?project=${encodeURIComponent(repoId)}`,
    ),
  getRepoTree: (repoId: string, branch?: string) =>
    api.get<{ tree: GitFile[] }>(
      `/gitlab/projects/tree?project=${encodeURIComponent(repoId)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`,
    ),
  getFileContents: (repoId: string, path: string, branch?: string) =>
    api.get<GitFileContent>(
      `/gitlab/projects/contents?project=${encodeURIComponent(repoId)}&path=${encodeURIComponent(path)}${branch ? `&branch=${encodeURIComponent(branch)}` : ''}`,
    ),
  getPullRequestComments: (repoId: string, mrIid: number) =>
    api.get<{ comments: GitComment[] }>(
      `/gitlab/projects/merge_requests/${mrIid}/notes?project=${encodeURIComponent(repoId)}`,
    ),
};

// =============================================================================
// Provider lookup — given a `gitProvider` field, return the matching service.
// =============================================================================

export const getGitProviderService = (provider: GitProvider): GitProviderService => {
  return provider === 'gitlab' ? gitlabService : githubService;
};

// =============================================================================
// Provider display terminology — centralizes user-facing wording so UI copy
// stays correct per provider. GitHub uses "Pull Request" (PR); GitLab uses
// "Merge Request" (MR). `label` is the brand name for buttons/headings.
// =============================================================================

export interface GitProviderTerminology {
  label: string;
  // The change-request term, e.g. "Pull Request" / "Merge Request".
  changeRequest: string;
  // The short form, e.g. "PR" / "MR".
  changeRequestShort: string;
}

const GIT_PROVIDER_TERMINOLOGY: Record<GitProvider, GitProviderTerminology> = {
  github: { label: 'GitHub', changeRequest: 'Pull Request', changeRequestShort: 'PR' },
  gitlab: { label: 'GitLab', changeRequest: 'Merge Request', changeRequestShort: 'MR' },
};

export const gitProviderTerminology = (provider: GitProvider): GitProviderTerminology =>
  GIT_PROVIDER_TERMINOLOGY[provider] ?? GIT_PROVIDER_TERMINOLOGY.github;
