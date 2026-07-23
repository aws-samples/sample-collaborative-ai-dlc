import { api } from './api';
import type { GitComment, GitFile, GitFileContent, GitProvider } from './gitProvider';

export type SourceControlAuthType =
  | 'github-oauth'
  | 'github-app'
  | 'gitlab-oauth'
  | 'bitbucket-oauth';
export type SourceControlBindingState = 'active' | 'invalid' | 'unbound';

export const SOURCE_CONTROL_AUTH_OPTIONS: Record<
  GitProvider,
  { defaultAuthType: SourceControlAuthType; options: SourceControlAuthType[] }
> = {
  github: { defaultAuthType: 'github-app', options: ['github-app', 'github-oauth'] },
  gitlab: { defaultAuthType: 'gitlab-oauth', options: ['gitlab-oauth'] },
  bitbucket: { defaultAuthType: 'bitbucket-oauth', options: ['bitbucket-oauth'] },
};

export const defaultSourceControlAuthType = (provider: GitProvider) =>
  SOURCE_CONTROL_AUTH_OPTIONS[provider].defaultAuthType;

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
