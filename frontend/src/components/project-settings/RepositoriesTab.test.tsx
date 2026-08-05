import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import type { Project } from '@/services/projects';
import type { ProjectSourceControlStatus } from '@/services/sourceControl';

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
vi.mock('@/services/sourceControl', async (importOriginal) => {
  // Keep the real auth-option metadata (SOURCE_CONTROL_AUTH_OPTIONS +
  // defaultAuthTypeFor — pure data, no side effects) that
  // SourceControlBindingSection consumes; mock only the network service.
  const actual = await importOriginal<typeof import('@/services/sourceControl')>();
  return {
    ...actual,
    sourceControlService: {
      getStatus: (...args: unknown[]) => getStatus(...args),
      bind: vi.fn(),
      unbind: vi.fn(),
    },
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

beforeEach(() => {
  getStatus.mockReset().mockImplementation(() => Promise.resolve(sourceStatus.value));
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
});
