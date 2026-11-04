import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { GitProvider, GitRepo } from '@/services/gitProvider';
import { GitRepoSelect } from './GitRepoSelect';

const listRepos = vi.hoisted(() => vi.fn());
const searchRepos = vi.hoisted(() => vi.fn());

vi.mock('@/services/gitProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gitProvider')>();
  return {
    ...actual,
    getGitProviderService: (provider: GitProvider) => {
      const service = actual.getGitProviderService(provider);
      // Only mock searchRepos where the real service offers it, so the tests
      // also cover which providers search server-side.
      return { ...service, listRepos, ...(service.searchRepos ? { searchRepos } : {}) };
    },
  };
});

const repo = (id: number, fullName: string): GitRepo => ({
  id,
  name: fullName.split('/').at(-1) ?? fullName,
  fullName,
  private: true,
  defaultBranch: 'main',
});

const recent = repo(1, 'org/squad/recent-app');
const deep = repo(2, 'org/shared/emu/utilities/steering-docs');

const ARN = 'arn:aws:codecommit:eu-west-1:123456789012:payments-api';

beforeEach(() => {
  vi.useFakeTimers();
  listRepos.mockReset();
  searchRepos.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

// Render and settle the initial listRepos fetch.
const renderPicker = async (provider: GitProvider, onChange = vi.fn()) => {
  render(<GitRepoSelect provider={provider} multiple value={[]} onChange={onChange} />);
  await act(async () => {});
  return onChange;
};

const typeSearch = async (value: string) => {
  fireEvent.change(screen.getByPlaceholderText('Search repositories...'), { target: { value } });
  // Run past the debounce and settle any search request it starts.
  await act(() => vi.advanceTimersByTimeAsync(1000));
};

describe('GitRepoSelect server-side search', () => {
  it('finds a GitLab project beyond the capped list and keeps it selectable', async () => {
    // The unfiltered list stops before the deep project; only search finds it.
    listRepos.mockResolvedValue([recent]);
    searchRepos.mockResolvedValue([deep]);
    const onChange = await renderPicker('gitlab');

    await typeSearch('emu steering');

    expect(searchRepos).toHaveBeenCalledWith('emu steering');
    expect(screen.queryByTitle(recent.fullName)).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(deep.fullName));
    expect(onChange).toHaveBeenCalledWith([deep]);
  });

  it('does not search GitLab for terms shorter than three characters', async () => {
    listRepos.mockResolvedValue([recent]);
    await renderPicker('gitlab');

    await typeSearch('re');

    expect(screen.getByTitle(recent.fullName)).toBeInTheDocument();
    expect(searchRepos).not.toHaveBeenCalled();
  });

  it('keeps filtering locally for providers without server-side search', async () => {
    listRepos.mockResolvedValue([recent, deep]);
    await renderPicker('github');

    await typeSearch('steering');

    expect(screen.queryByTitle(recent.fullName)).not.toBeInTheDocument();
    expect(screen.getByTitle(deep.fullName)).toBeInTheDocument();
    expect(listRepos).toHaveBeenCalledTimes(1);
    expect(searchRepos).not.toHaveBeenCalled();
  });
});

// Exercise the generic listRepos path: GitRepoSelect must drive CodeCommit the
// same way as GitLab/Bitbucket, with no CodeCommit-specific repo source.
describe('GitRepoSelect, CodeCommit via the generic path', () => {
  // These tests wait on the initial fetch with findBy*, which needs real timers.
  beforeEach(() => {
    vi.useRealTimers();
  });

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
