import { api } from './api';

// =============================================================================
// Shared types — provider-agnostic shapes returned by both GitHub and GitLab.
// =============================================================================

// The set of supported git providers. Kept as a string-literal union (not a TS
// enum) because the values are wire strings sent to/from the API and stored in
// the DB — a union assigns directly from those strings with zero runtime cost.
export type GitProvider = 'github' | 'gitlab' | 'bitbucket' | 'codecommit';

// A git provider and its issue-tracker share one OAuth app/connection, so each
// git provider maps to exactly one tracker-provider id. Centralized here so the
// association lives in one place instead of being re-derived with inline
// ternaries at every call site. Code-host-only providers (Bitbucket has no
// issues tracker implemented, CodeCommit has no issues at all) map to null.
export type GitTrackerProviderId = 'github-issues' | 'gitlab-issues' | 'bitbucket-issues';

const GIT_PROVIDER_TRACKER_ID: Record<GitProvider, GitTrackerProviderId | null> = {
  github: 'github-issues',
  gitlab: 'gitlab-issues',
  bitbucket: 'bitbucket-issues',
  codecommit: null,
};

export const trackerIdForGitProvider = (provider: GitProvider): GitTrackerProviderId | null =>
  GIT_PROVIDER_TRACKER_ID[provider];

// Providers reached through a personal OAuth connection (Connect button, OAuth
// callback round-trip). CodeCommit is reached through an IAM role the tenant
// trusts the platform with; there is nothing personal to connect.
export type OAuthGitProvider = Exclude<GitProvider, 'codecommit'>;
export const isOAuthGitProvider = (provider: GitProvider | ''): provider is OAuthGitProvider =>
  provider === 'github' || provider === 'gitlab' || provider === 'bitbucket';

export const GIT_PROVIDERS: readonly GitProvider[] = [
  'github',
  'gitlab',
  'bitbucket',
  'codecommit',
];
export const isGitProvider = (value: unknown): value is GitProvider =>
  typeof value === 'string' && (GIT_PROVIDERS as readonly string[]).includes(value);

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
  if (provider === 'codecommit') return codecommitStatusService;
  return githubService;
};

// =============================================================================
// CodeCommit — no personal connection. The status route reports whether the
// deployment can build a trust policy (platform principals present); a
// "connection" is a role the tenant creates, handled by services/codecommit.ts.
// The auth/disconnect members exist to satisfy the shared interface and reject
// deliberately: the UI never renders a Connect button for this provider.
// =============================================================================

export interface CodeCommitStatus {
  provider: 'codecommit';
  configured: boolean;
  principals: string[];
}

export const codecommitStatusService: GitProviderService = {
  getAuthUrl: () => Promise.reject(new Error('CodeCommit has no OAuth connection')),
  getStatus: async () => {
    const status = await api.get<CodeCommitStatus>('/codecommit/status');
    // "connected" here means "this deployment can connect CodeCommit at all";
    // the per-role handshake happens in the connect form.
    return { connected: status.configured, provider: 'codecommit' };
  },
  listRepos: () => Promise.reject(new Error('CodeCommit repositories are listed per role')),
  disconnect: () => Promise.resolve(),
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
  codecommit: { label: 'AWS CodeCommit', changeRequest: 'Pull Request', changeRequestShort: 'PR' },
};

export const gitProviderTerminology = (provider: GitProvider): GitProviderTerminology =>
  GIT_PROVIDER_TERMINOLOGY[provider] ?? GIT_PROVIDER_TERMINOLOGY.github;

// =============================================================================
// Repository identity. GitHub/GitLab/Bitbucket ids are "owner/repo" paths; a
// CodeCommit id is the repository ARN (region and account are part of the
// identity). These helpers keep that difference out of the components.
// =============================================================================

const CODECOMMIT_ARN =
  /^arn:(aws|aws-cn|aws-us-gov):codecommit:([a-z]{2}(?:-[a-z]+)+-\d):(\d{12}):([\w.-]{1,100})$/;

export interface CodeCommitRepoRef {
  arn: string;
  partition: string;
  region: string;
  accountId: string;
  name: string;
}

export const parseCodeCommitRepo = (repoId: string): CodeCommitRepoRef | null => {
  const m = CODECOMMIT_ARN.exec(repoId ?? '');
  return m ? { arn: repoId, partition: m[1], region: m[2], accountId: m[3], name: m[4] } : null;
};

// Human label for a repository id: "owner/repo" as-is, an ARN as "name (region)".
export const repoDisplayName = (provider: GitProvider, repoId: string): string => {
  if (provider !== 'codecommit') return repoId;
  const ref = parseCodeCommitRepo(repoId);
  return ref ? `${ref.name} (${ref.region})` : repoId;
};

const consoleHost = (partition: string, region: string) =>
  partition === 'aws-cn'
    ? `https://${region}.console.amazonaws.cn`
    : `https://${region}.console.aws.amazon.com`;

// Web URL of a repository (its home page, or a path within a branch). The
// branch is taken raw; SaaS hosts get it URL-encoded segment by segment (a "/"
// in a branch name stays a path separator), the CodeCommit console takes it
// verbatim under refs/heads/.
export const repoWebUrl = (
  provider: GitProvider,
  repoId: string,
  opts: { branch?: string; path?: string } = {},
): string | null => {
  const enc = opts.branch ? opts.branch.split('/').map(encodeURIComponent).join('/') : '';
  const sub = opts.path ? `/${opts.path}` : '';
  if (provider === 'codecommit') {
    const ref = parseCodeCommitRepo(repoId);
    if (!ref) return null;
    const base = `${consoleHost(ref.partition, ref.region)}/codesuite/codecommit/repositories/${ref.name}`;
    const where = opts.branch ? `/browse/refs/heads/${opts.branch}/--${sub || '/'}` : '/browse';
    return `${base}${where}?region=${ref.region}`;
  }
  if (provider === 'gitlab')
    return `https://gitlab.com/${repoId}${enc ? `/-/tree/${enc}${sub}` : ''}`;
  if (provider === 'bitbucket')
    return `https://bitbucket.org/${repoId}${enc ? `/src/${enc}${sub}` : ''}`;
  return `https://github.com/${repoId}${enc ? `/tree/${enc}${sub}` : ''}`;
};
