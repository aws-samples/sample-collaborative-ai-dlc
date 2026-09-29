import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { getStatus, bind, connectInfo, listRepos } = vi.hoisted(() => ({
  getStatus: vi.fn(),
  bind: vi.fn(),
  connectInfo: vi.fn(),
  listRepos: vi.fn(),
}));

vi.mock('@/services/sourceControl', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/sourceControl')>();
  return {
    ...actual,
    sourceControlService: { ...actual.sourceControlService, getStatus, bind },
  };
});
vi.mock('@/services/codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/codecommit')>();
  return { ...actual, codecommitService: { connectInfo, listRepos } };
});
vi.mock('@/hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({ status: null, loading: false, error: null, refresh: vi.fn() }),
}));

import { SourceControlBindingSection } from './SourceControlBindingSection';
import type { Project } from '@/services/projects';

const ROLE = 'arn:aws:iam::123456789012:role/owner-role';
const REPO = 'arn:aws:codecommit:eu-west-1:123456789012:demo';
const ADMIN_ID = 'aidlc:7c9e6679-7425-40de-944b-e07fc1f90ae7';

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
      roleArn: ROLE,
      region: 'eu-west-1',
    },
  ],
};

describe('SourceControlBindingSection, CodeCommit rebind', () => {
  beforeEach(() => {
    getStatus.mockReset().mockResolvedValue(boundStatus);
    bind.mockReset().mockResolvedValue(boundStatus);
    // The co-admin's own connection: another external ID, which the owner's
    // role does not trust.
    connectInfo.mockReset().mockResolvedValue({
      externalId: ADMIN_ID,
      principals: [],
      trustPolicy: {
        Statement: [{ Condition: { StringEquals: { 'sts:ExternalId': ADMIN_ID } } }],
      },
      permissionsPolicy: { Statement: [] },
      regions: ['eu-west-1'],
    });
    listRepos.mockReset().mockRejectedValue(new Error('ROLE_ASSUMPTION_DENIED'));
  });

  it('re-verifies the bound role without personal discovery or the caller trust policy', async () => {
    render(<SourceControlBindingSection project={project} canEdit />);
    expect(await screen.findByTestId('codecommit-reverify')).toHaveTextContent(ROLE);
    // The co-admin's own trust policy is never rendered on this path.
    expect(connectInfo).not.toHaveBeenCalled();
    expect(screen.queryByTestId('codecommit-trust-policy')).not.toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'Rebind and verify' }));
    await waitFor(() => expect(bind).toHaveBeenCalledTimes(1));
    // No external ID from the client: the server resolves the one the
    // project binding already uses.
    expect(bind).toHaveBeenCalledWith('p1', {
      codecommit: { authType: 'codecommit-role', roleArn: ROLE },
    });
    expect(listRepos).not.toHaveBeenCalled();
  });

  it('requires a fresh test when switching to a different role', async () => {
    render(<SourceControlBindingSection project={project} canEdit />);
    await userEvent.click(await screen.findByRole('button', { name: 'Use a different role' }));
    expect(await screen.findByTestId('codecommit-trust-policy')).toHaveTextContent(ADMIN_ID);

    await userEvent.click(screen.getByRole('button', { name: 'Rebind and verify' }));
    expect(await screen.findByText('Test the CodeCommit connection before binding.')).toBeVisible();
    expect(bind).not.toHaveBeenCalled();
  });
});
