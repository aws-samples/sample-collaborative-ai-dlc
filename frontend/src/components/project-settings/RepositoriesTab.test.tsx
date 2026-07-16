import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Project } from '@/services/projects';
import type { GitProviderStatus } from '@/services/gitProvider';

const status = vi.hoisted(() => ({
  value: {
    connected: false,
    mode: 'oauth',
    reauthorizationRequired: true,
    missingScopes: ['workflow'],
  } as GitProviderStatus,
}));

vi.mock('@/hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({
    status: status.value,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

vi.mock('@/hooks/useTrackerProviders', () => ({
  useTrackerProviders: () => ({
    providers: [{ id: 'github-issues', configured: true }],
    loading: false,
    failed: false,
  }),
}));

import { RepositoriesTab } from './RepositoriesTab';

const project = {
  id: 'project-1',
  gitProvider: 'github',
  gitRepo: 'acme/api',
  repos: [{ url: 'acme/api', role: 'primary' }],
} as Project;

describe('RepositoriesTab', () => {
  it('shows GitHub reauthorization in project source-control settings', () => {
    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);

    expect(screen.getByText('GitHub connection')).toBeInTheDocument();
    expect(screen.getByText('Action required')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reauthorize GitHub' })).toBeInTheDocument();
    expect(screen.getByText(/grant workflow permission/)).toBeInTheDocument();
  });

  it('shows platform-managed status instead of personal auth in GitHub App mode', () => {
    status.value = {
      connected: true,
      mode: 'app',
      reauthorizationRequired: false,
      missingScopes: [],
    };

    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);

    expect(screen.getByText(/uses a GitHub App installation/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GitHub/ })).not.toBeInTheDocument();
  });

  it('surfaces missing GitHub App permissions as administrator action', () => {
    status.value = {
      connected: false,
      mode: 'app',
      reauthorizationRequired: false,
      missingScopes: [],
      configurationRequired: true,
      configurationError:
        'GitHub App installation is missing required permissions: workflows:write',
    };

    render(<RepositoriesTab project={project} canEdit reload={vi.fn()} />);

    expect(screen.getByText(/workflows:write/)).toBeInTheDocument();
    expect(screen.getByText(/Platform Admin/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /GitHub/ })).not.toBeInTheDocument();
  });
});
