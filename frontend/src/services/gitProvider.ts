import { api } from './api';

// =============================================================================
// Shared types — provider-agnostic shapes returned by every git provider.
// =============================================================================

// The set of supported git providers. Kept as a string-literal union (not a TS
// enum) because the values are wire strings sent to/from the API and stored in
// the DB — a union assigns directly from those strings with zero runtime cost.
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

export const GIT_PROVIDER_WEB_URL: Record<GitProvider, string> = {
  github: 'https://github.com',
  gitlab: 'https://gitlab.com',
  bitbucket: 'https://bitbucket.org',
};

export const gitRepoSlug = (repo: string) =>
  repo
    .replace(/^https?:\/\/[^/]+\//, '')
    .replace(/^git@[^:]+:/, '')
    .replace(/\.git$/, '')
    .replace(/^\/+|\/+$/g, '');

export const gitProviderForRepo = (
  repo: string,
  fallback: string | null | undefined,
  providers: Record<string, string> | null | undefined,
): string | null => providers?.[repo] ?? providers?.[gitRepoSlug(repo)] ?? fallback ?? null;

const configuredRepoBaseUrl = (repo: string): string | null => {
  const trimmed = repo.replace(/\.git$/, '').replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    return ['http:', 'https:'].includes(url.protocol)
      ? `${url.origin}${url.pathname.replace(/\/+$/, '')}`
      : null;
  } catch {
    const ssh = /^git@([^:]+):(.+)$/.exec(trimmed);
    return ssh ? `https://${ssh[1]}/${ssh[2].replace(/^\/+/, '')}` : null;
  }
};

export const gitBranchWebUrl = (
  provider: string | null | undefined,
  repo: string,
  branch: string,
): string | null => {
  if (!provider || !Object.hasOwn(GIT_PROVIDER_WEB_URL, provider)) return null;
  const encodedBranch = branch.split('/').map(encodeURIComponent).join('/');
  const typedProvider = provider as GitProvider;
  const base =
    configuredRepoBaseUrl(repo) ?? `${GIT_PROVIDER_WEB_URL[typedProvider]}/${gitRepoSlug(repo)}`;
  if (typedProvider === 'gitlab') return `${base}/-/tree/${encodedBranch}`;
  if (typedProvider === 'bitbucket') return `${base}/src/${encodedBranch}`;
  return `${base}/tree/${encodedBranch}`;
};

// A git provider and its issue-tracker share one OAuth app/connection, so each
// git provider maps to exactly one tracker-provider id. Centralized here so the
// association lives in one place instead of being re-derived with inline
// ternaries at every call site.
export type GitTrackerProviderId = 'github-issues' | 'gitlab-issues' | 'bitbucket-issues';

const GIT_PROVIDER_TRACKER_ID: Record<GitProvider, GitTrackerProviderId> = {
  github: 'github-issues',
  gitlab: 'gitlab-issues',
  bitbucket: 'bitbucket-issues',
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
  reauthorizationRequired?: boolean;
  missingScopes?: string[];
}

// Admin-only GitHub integration config (GET/PUT /github/admin/config,
// platform-admin gated on the backend).
export interface GitHubAdminConfig {
  oauthConfigured: boolean;
  appId: string | null;
  privateKeySet: boolean;
  appConfigured: boolean;
  appConfigurationError?: string;
  appIdentity?: string | null;
}

export interface GitHubAdminConfigUpdate {
  appId?: string;
  privateKey?: string;
}

export const githubAdminService = {
  getConfig: () => api.get<GitHubAdminConfig>('/github/admin/config'),
  updateConfig: (update: GitHubAdminConfigUpdate) =>
    api.put<GitHubAdminConfig>('/github/admin/config', update),
};

// App-credentialed discovery for the create-space GitHub App path. These
// routes authenticate with the platform App (not the caller's OAuth
// connection), so they work for users who never connected GitHub personally.
export const githubAppService = {
  getStatus: () => api.get<{ configured: boolean }>('/github/app/status'),
  listRepos: () => api.get<GitRepo[]>('/github/app/repos'),
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
// Provider service interface — implemented by GitHub, GitLab and Bitbucket.
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
}

// =============================================================================
// GitHub service implementation — splits the "owner/repo" repoId into the
// two path segments the GitHub routes expect.
// =============================================================================

export const githubService: GitProviderService = {
  getAuthUrl: () => api.get<{ url: string }>('/github/auth'),
  getStatus: () => api.get<GitProviderStatus>('/github/status'),
  listRepos: () => api.get<GitRepo[]>('/github/repos'),
  disconnect: () => api.delete('/github/disconnect'),
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
};

// =============================================================================
// Bitbucket service implementation — Bitbucket Cloud addresses repositories by
// a two-segment "workspace/repo_slug" path, the same shape as GitHub's
// "owner/repo", so it splits the repoId into two path segments exactly like
// the GitHub service (not GitLab's ?project= query string).
// =============================================================================

export const bitbucketService: GitProviderService = {
  getAuthUrl: () => api.get<{ url: string }>('/bitbucket/auth'),
  getStatus: () => api.get<GitProviderStatus>('/bitbucket/status'),
  listRepos: () => api.get<GitRepo[]>('/bitbucket/repos'),
  disconnect: () => api.delete('/bitbucket/disconnect'),
};

// =============================================================================
// Provider lookup — given a `gitProvider` field, return the matching service.
// =============================================================================

export const getGitProviderService = (provider: GitProvider): GitProviderService => {
  if (provider === 'gitlab') return gitlabService;
  if (provider === 'bitbucket') return bitbucketService;
  return githubService;
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
  bitbucket: { label: 'Bitbucket', changeRequest: 'Pull Request', changeRequestShort: 'PR' },
};

export const gitProviderTerminology = (provider: GitProvider): GitProviderTerminology =>
  GIT_PROVIDER_TERMINOLOGY[provider] ?? GIT_PROVIDER_TERMINOLOGY.github;
