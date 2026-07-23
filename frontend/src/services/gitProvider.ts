import { api } from './api';

// =============================================================================
// Shared types — provider-agnostic shapes returned by both GitHub and GitLab.
// =============================================================================

// The set of supported git providers. Kept as a string-literal union (not a TS
// enum) because the values are wire strings sent to/from the API and stored in
// the DB — a union assigns directly from those strings with zero runtime cost.
export type GitProvider = 'github' | 'gitlab' | 'bitbucket';

// GitHub and GitLab each share one OAuth app/connection with their issue
// tracker. Bitbucket is a code host only, so it has no tracker-provider id.
export type GitTrackerProviderId = 'github-issues' | 'gitlab-issues';

const GIT_PROVIDER_TRACKER_ID: Partial<Record<GitProvider, GitTrackerProviderId>> = {
  github: 'github-issues',
  gitlab: 'gitlab-issues',
};

export const trackerIdForGitProvider = (provider: GitProvider): GitTrackerProviderId | null =>
  GIT_PROVIDER_TRACKER_ID[provider] ?? null;

const GIT_PROVIDER_CALLBACK_META: Record<
  GitProvider,
  { callbackPath: string; displayName: string }
> = {
  github: { callbackPath: '/github/callback', displayName: 'GitHub' },
  gitlab: { callbackPath: '/gitlab/callback', displayName: 'GitLab' },
  bitbucket: { callbackPath: '/bitbucket/callback', displayName: 'Bitbucket' },
};

export const gitProviderCallbackMeta = (provider: GitProvider) =>
  GIT_PROVIDER_CALLBACK_META[provider];

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

export interface OAuthProviderAdminConfig {
  configured: boolean;
}

export const githubAdminService = {
  getConfig: () => api.get<GitHubAdminConfig>('/github/admin/config'),
  updateConfig: (update: GitHubAdminConfigUpdate) =>
    api.put<GitHubAdminConfig>('/github/admin/config', update),
};

export const bitbucketAdminService = {
  getConfig: () => api.get<OAuthProviderAdminConfig>('/bitbucket/oauth-config'),
  setOAuthConfig: (clientId: string, clientSecret: string) =>
    api.put<{ success: true }>('/bitbucket/oauth-config', { clientId, clientSecret }),
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

// ============================================================================
// Bitbucket service implementation. Project-bound repository operations use
// sourceControlService.
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
