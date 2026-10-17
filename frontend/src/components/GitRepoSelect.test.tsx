import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';

// Exercise the generic listRepos path: GitRepoSelect must drive CodeCommit the
// same way as GitLab/Bitbucket, with no CodeCommit-specific repo source.
const listRepos = vi.hoisted(() => vi.fn());
vi.mock('../services/gitProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitProvider')>();
  return {
    ...actual,
    getGitProviderService: (provider: Parameters<typeof actual.getGitProviderService>[0]) => ({
      ...actual.getGitProviderService(provider),
      listRepos,
    }),
  };
});

import { GitRepoSelect } from './GitRepoSelect';

const ARN = 'arn:aws:codecommit:eu-west-1:123456789012:payments-api';

beforeEach(() => {
  listRepos.mockReset();
});

describe('GitRepoSelect, CodeCommit via the generic path', () => {
  it('lists repositories through the provider service and shows friendly names', async () => {
    listRepos.mockResolvedValue([
      { id: 1, name: 'payments-api', fullName: ARN, private: true, defaultBranch: 'main' },
    ]);
    render(<GitRepoSelect provider="codecommit" multiple value={[]} onChange={() => {}} />);

    // Fetched via the generic path (not a pre-fetched prop, not a codecommit route).
    expect(await screen.findByText('payments-api (eu-west-1)')).toBeInTheDocument();
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('shows the generic empty message plus the CodeCommit admin hint when the role sees nothing', async () => {
    listRepos.mockResolvedValue([]);
    render(<GitRepoSelect provider="codecommit" multiple value={[]} onChange={() => {}} />);

    expect(await screen.findByText('No repositories available')).toBeInTheDocument();
    expect(
      screen.getByText(
        'Ask your AWS admin to grant the platform role access to the repositories you need.',
      ),
    ).toBeInTheDocument();
  });

  it('does not show the CodeCommit hint for other providers', async () => {
    listRepos.mockResolvedValue([]);
    render(<GitRepoSelect provider="gitlab" multiple value={[]} onChange={() => {}} />);

    expect(await screen.findByText('No repositories available')).toBeInTheDocument();
    expect(screen.queryByText(/Ask your AWS admin/)).not.toBeInTheDocument();
  });
});
