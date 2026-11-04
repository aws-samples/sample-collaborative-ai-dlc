import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getStatus, bind, unbind } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  bind: vi.fn(),
  unbind: vi.fn(),
}));

vi.mock('@/services/sourceControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sourceControl')>();
  return {
    ...actual,
    sourceControlService: { ...actual.sourceControlService, getStatus, bind, unbind },
  };
});
// CodeCommit binds to the one platform connection: there is no per-user role
// form, so useGitProviderStatus (the connection check) is all this section
// touches. "connected" = an admin configured the platform role.
vi.mock('@/hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({
    status: { connected: true },
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
}));

import { SourceControlBindingSection } from './SourceControlBindingSection';
import type { Project } from '@/services/projects';

const ROLE = 'arn:aws:iam::123456789012:role/owner-role';
const REPO = 'arn:aws:codecommit:eu-west-1:123456789012:demo';

const project = {
  id: 'p1',
  gitProvider: 'codecommit',
  repos: [{ url: REPO, provider: 'codecommit' }],
} as unknown as Project;

const boundStatus = {
  ready: true,
  repositories: [
    {
      provider: 'codecommit',
      repo: REPO,
      authType: 'codecommit-role',
      status: 'active',
      invalidReason: null,
      capabilities: { repositoryWrite: true },
      verifiedAt: null,
      updatedAt: null,
      // The backend still returns the role ARN on the binding record, but the
      // row must never render it — only the region.
      roleArn: ROLE,
      region: 'eu-west-1',
    },
  ],
};

describe('SourceControlBindingSection, CodeCommit', () => {
  beforeEach(() => {
    getStatus.mockReset().mockResolvedValue(boundStatus);
    bind.mockReset().mockResolvedValue(boundStatus);
    unbind.mockReset().mockResolvedValue(undefined);
  });

  it('shows the region, never the role ARN, and has no per-user role form', async () => {
    render(<SourceControlBindingSection project={project} canEdit />);
    // Region label on the binding row; the admin-only role ARN never appears.
    expect(await screen.findByText('CodeCommit (eu-west-1)')).toBeInTheDocument();
    expect(screen.queryByText(ROLE)).not.toBeInTheDocument();
    // None of the removed per-user handshake UI is rendered.
    expect(screen.queryByTestId('codecommit-trust-policy')).not.toBeInTheDocument();
    expect(screen.queryByTestId('codecommit-reverify')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a different role' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: '3. Test connection' })).not.toBeInTheDocument();
  });

  it('rebinds to the platform connection without sending a role or external id', async () => {
    render(<SourceControlBindingSection project={project} canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: 'Rebind and verify' }));
    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    // Only the auth type: the backend resolves the platform role ARN and
    // external ID server-side.
    expect(bind).toHaveBeenCalledWith('p1', {
      codecommit: { authType: 'codecommit-role' },
    });
  });

  it('tells the user to ask a platform admin when CodeCommit is not configured', async () => {
    vi.resetModules();
    vi.doMock('@/hooks/useGitProviderStatus', () => ({
      useGitProviderStatus: () => ({
        status: { connected: false },
        loading: false,
        error: null,
        refresh: vi.fn(),
      }),
    }));
    const { SourceControlBindingSection: Section } = await import('./SourceControlBindingSection');
    render(<Section project={project} canEdit />);
    expect(await screen.findByText(/Ask a platform admin to configure it/i)).toBeInTheDocument();
    vi.doUnmock('@/hooks/useGitProviderStatus');
  });
});
