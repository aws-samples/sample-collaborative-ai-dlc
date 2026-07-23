import { api } from './api';
import type { GitComment, GitFile, GitFileContent, GitProvider } from './gitProvider';

export type SourceControlAuthType = 'github-oauth' | 'github-app' | 'gitlab-oauth' | 'bitbucket-oauth';
export type SourceControlBindingState = 'active' | 'invalid' | 'unbound';

// Per-provider source-control auth options + default, centralized so the
// create-project modal and the project-settings binding section consume one
// source of truth instead of hard-coding `provider === 'github' ? … : …`
// ternaries at each call site. `options` is ordered (first = preferred).
export interface SourceControlAuthOption {
  authType: SourceControlAuthType;
  label: string;
  description: string;
  // OAuth delegation requires an explicit confirmation before binding; the
  // GitHub App path does not (it uses the platform installation).
  requiresDelegationConfirmation: boolean;
}

export const SOURCE_CONTROL_AUTH_OPTIONS: Record<
  GitProvider,
  SourceControlAuthOption[]
> = {
  github: [
    {
      authType: 'github-app',
      label: 'GitHub App',
      description:
        'Uses the platform GitHub App installation. No personal GitHub connection needed.',
      requiresDelegationConfirmation: false,
    },
    {
      authType: 'github-oauth',
      label: 'My GitHub OAuth identity',
      description: 'The space delegates your personal connection for repository access.',
      requiresDelegationConfirmation: true,
    },
  ],
  gitlab: [
    {
      authType: 'gitlab-oauth',
      label: 'Delegated GitLab OAuth',
      description: 'The space delegates your personal GitLab connection for repository access.',
      requiresDelegationConfirmation: true,
    },
  ],
  bitbucket: [
    {
      authType: 'bitbucket-oauth',
      label: 'Delegated Bitbucket OAuth',
      description: 'The space delegates your personal Bitbucket connection for repository access.',
      requiresDelegationConfirmation: true,
    },
  ],
};

// The preferred (default) auth type for a provider — first option in the list.
export const defaultAuthTypeFor = (
  provider: GitProvider,
): SourceControlAuthType => SOURCE_CONTROL_AUTH_OPTIONS[provider][0].authType;

export interface SourceControlCapabilities {
  metadata?: 'read' | 'none';
  contents?: 'read' | 'write' | 'none';
  pullRequests?: 'read' | 'write' | 'none';
  issues?: 'read' | 'write' | 'none';
  workflows?: 'write' | 'none';
  repositoryWrite?: boolean;
  accessLevel?: number;
}

export interface SourceControlRepositoryStatus {
  provider: GitProvider;
  repo: string;
  authType: SourceControlAuthType | null;
  status: SourceControlBindingState;
  invalidReason: string | null;
  capabilities: SourceControlCapabilities;
  verifiedAt: string | null;
  updatedAt: string | null;
  delegatedBy?: string | null;
  installationId?: string | null;
  installationAccount?: string | null;
  actor?: string | null;
}

export interface ProjectSourceControlStatus {
  ready: boolean;
  repositories: SourceControlRepositoryStatus[];
}

export type SourceControlProviderSelection = Partial<
  Record<
    GitProvider,
    {
      authType: SourceControlAuthType;
      confirmDelegation?: boolean;
    }
  >
>;

const query = (provider: GitProvider, repository: string, extra?: Record<string, string>) => {
  const params = new URLSearchParams({ provider, repository, ...extra });
  return params.toString();
};

export const sourceControlService = {
  getStatus: (projectId: string) =>
    api.get<ProjectSourceControlStatus>(`/projects/${projectId}/source-control`),

  bind: (projectId: string, providers: SourceControlProviderSelection) =>
    api.put<ProjectSourceControlStatus>(`/projects/${projectId}/source-control`, {
      providers,
    }),

  unbind: (projectId: string) => api.delete(`/projects/${projectId}/source-control`),

  async listBranches(projectId: string, provider: GitProvider, repository: string) {
    return api.get<{ branches: string[]; defaultBranch?: string }>(
      `/projects/${projectId}/source-control/branches?${query(provider, repository)}`,
    );
  },

  async getTree(projectId: string, provider: GitProvider, repository: string, branch?: string) {
    const tree = await api.get<GitFile[]>(
      `/projects/${projectId}/source-control/tree?${query(
        provider,
        repository,
        branch ? { branch } : undefined,
      )}`,
    );
    return { tree };
  },

  getFileContents(
    projectId: string,
    provider: GitProvider,
    repository: string,
    path: string,
    branch?: string,
  ) {
    return api.get<GitFileContent>(
      `/projects/${projectId}/source-control/contents?${query(provider, repository, {
        path,
        ...(branch ? { branch } : {}),
      })}`,
    );
  },

  async getReviewComments(
    projectId: string,
    provider: GitProvider,
    repository: string,
    reviewId: number,
  ) {
    const comments = await api.get<GitComment[]>(
      `/projects/${projectId}/source-control/reviews/${reviewId}/comments?${query(
        provider,
        repository,
      )}`,
    );
    return { comments };
  },
};
