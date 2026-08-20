import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Project } from '@/services/projects';
import type { ProjectSourceControlStatus, SourceControlAuthType } from '@/services/sourceControl';
import type { GitProvider, GitRepo } from '@/services/gitProvider';

const sourceStatus = vi.hoisted(() => ({
  value: {
    ready: false,
    repositories: [
      {
        provider: 'github',
        repo: 'acme/api',
        authType: null,
        status: 'unbound',
        invalidReason: 'binding_required',
        capabilities: {},
        verifiedAt: null,
        updatedAt: null,
      },
    ],
  } as ProjectSourceControlStatus,
}));

const getStatus = vi.hoisted(() => vi.fn());
const bind = vi.hoisted(() => vi.fn());
vi.mock('@/services/sourceControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sourceControl')>();
  return {
    ...actual,
    sourceControlService: {
      ...actual.sourceControlService,
      getStatus: (...args: unknown[]) => getStatus(...args),
      bind: (...args: unknown[]) => bind(...args),
      unbind: vi.fn(),
    },
  };
});

const appListRepos = vi.hoisted(() => vi.fn());
const githubOauthListRepos = vi.hoisted(() => vi.fn());
vi.mock('@/services/gitProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gitProvider')>();
  return {
    ...actual,
    githubAppService: { ...actual.githubAppService, listRepos: appListRepos },
    getGitProviderService: (provider: GitProvider) => ({
      ...actual.getGitProviderService(provider),
      listRepos: githubOauthListRepos,
    }),
  };
});

vi.mock('@/hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({
    status: { connected: true },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { RepositoriesTab } from './RepositoriesTab';

const project = {
  id: 'project-1',
  gitProvider: 'github',
  gitRepo: 'acme/api',
  repos: [{ url: 'acme/api', provider: 'github', role: 'primary' }],
} as Project;

const repo = (fullName: string): GitRepo => ({
  id: 1,
  name: fullName.split('/')[1],
  fullName,
  private: false,
  defaultBranch: 'main',
});

const boundStatus = (
  provider: GitProvider,
  authType: SourceControlAuthType,
  repoName: string,
): ProjectSourceControlStatus => ({
  ready: true,
  repositories: [
    {
      provider,
      repo: repoName,
      authType,
      status: 'active',
      invalidReason: null,
      capabilities: { repositoryWrite: true },
      verifiedAt: '2026-07-20T00:00:00Z',
      updatedAt: '2026-07-20T00:00:00Z',
    },
  ],
});

const openAddDialog = async () => {
  await userEvent.click(await screen.findByRole('button', { name: 'Add' }));
};

beforeEach(() => {
  vi.clearAllMocks();
  getStatus.mockReset().mockImplementation(() => Promise.resolve(sourceStatus.value));
  appListRepos.mockResolvedValue([]);
  githubOauthListRepos.mockResolvedValue([]);
});

describe('RepositoriesTab', () => {
  it('shows explicit project binding setup for an unbound repository', async () => {
    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);

    expect(await screen.findByText('Project source control')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Source control setup required. Starts remain blocked until every repository is verified.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Bind and verify' })).toBeInTheDocument();
    expect(screen.getByText('GitHub App')).toBeInTheDocument();
  });

  it('shows sanitized binding status to a plain member without controls', async () => {
    sourceStatus.value = {
      ready: true,
      repositories: [
        {
          provider: 'github',
          repo: 'acme/api',
          authType: 'github-app',
          status: 'active',
          invalidReason: null,
          capabilities: { repositoryWrite: true },
          verifiedAt: '2026-07-20T00:00:00Z',
          updatedAt: '2026-07-20T00:00:00Z',
        },
      ],
    };

    render(<RepositoriesTab project={project} canEdit={false} reload={vi.fn()} />);

    expect(await screen.findByText('Write verified')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /bind/i })).not.toBeInTheDocument();
  });

  it('discovers App repositories for a GitHub-App-bound space without personal OAuth', async () => {
    sourceStatus.value = boundStatus('github', 'github-app', 'acme/api');
    appListRepos.mockResolvedValue([repo('acme/app-only')]);
    githubOauthListRepos.mockRejectedValue(new Error('GitHub not connected'));

    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);
    await openAddDialog();

    expect(await screen.findByText('acme/app-only')).toBeInTheDocument();
    expect(appListRepos).toHaveBeenCalled();
    expect(githubOauthListRepos).not.toHaveBeenCalled();
    expect(screen.queryByText('GitHub not connected')).not.toBeInTheDocument();
  });

  it('discovers personal repositories for a GitHub-OAuth-bound space', async () => {
    sourceStatus.value = boundStatus('github', 'github-oauth', 'acme/api');
    githubOauthListRepos.mockResolvedValue([repo('acme/oauth-only')]);

    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);
    await openAddDialog();

    expect(await screen.findByText('acme/oauth-only')).toBeInTheDocument();
    expect(githubOauthListRepos).toHaveBeenCalled();
    expect(appListRepos).not.toHaveBeenCalled();
  });

  it('follows a rebinding without a page reload', async () => {
    sourceStatus.value = boundStatus('github', 'github-app', 'acme/api');
    appListRepos.mockResolvedValue([repo('acme/app-only')]);
    githubOauthListRepos.mockResolvedValue([repo('acme/oauth-only')]);
    bind.mockResolvedValue(boundStatus('github', 'github-oauth', 'acme/api'));

    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Rebind and verify' }));
    await openAddDialog();

    expect(await screen.findByText('acme/oauth-only')).toBeInTheDocument();
  });
});
