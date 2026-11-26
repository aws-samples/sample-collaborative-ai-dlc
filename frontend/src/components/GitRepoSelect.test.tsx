import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import type { GitProvider, GitRepo } from '@/services/gitProvider';
import { GitRepoSelect } from './GitRepoSelect';

const listRepos = vi.hoisted(() => vi.fn());
const searchRepos = vi.hoisted(() => vi.fn());
const listReposPage = vi.hoisted(() => vi.fn());

vi.mock('@/services/gitProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gitProvider')>();
  return {
    ...actual,
    getGitProviderService: (provider: GitProvider) => {
      const service = actual.getGitProviderService(provider);
      // Only mock searchRepos and listReposPage where the real service offers
      // them, so the tests also cover which providers search or page.
      return {
        ...service,
        listRepos,
        ...(service.searchRepos ? { searchRepos } : {}),
        ...(service.listReposPage ? { listReposPage } : {}),
      };
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
  listReposPage.mockReset();
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
    listReposPage.mockResolvedValue({ repos: [recent, deep], nextPage: null });
    await renderPicker('github');

    await typeSearch('steering');

    expect(screen.queryByTitle(recent.fullName)).not.toBeInTheDocument();
    expect(screen.getByTitle(deep.fullName)).toBeInTheDocument();
    expect(listReposPage).toHaveBeenCalledTimes(1);
    expect(listRepos).not.toHaveBeenCalled();
    expect(searchRepos).not.toHaveBeenCalled();
  });
});

describe('GitRepoSelect, GitHub repositories page by page', () => {
  const older = repo(101, 'org/older-service');

  it('shows page 1 while page 2 loads, then finds a repository from page 2', async () => {
    let releasePage2: (value: unknown) => void = () => {};
    listReposPage
      .mockResolvedValueOnce({ repos: [recent], nextPage: 2 })
      .mockReturnValueOnce(new Promise((resolve) => (releasePage2 = resolve)));
    const onChange = await renderPicker('github');

    expect(screen.getByTitle(recent.fullName)).toBeInTheDocument();
    expect(screen.getByText('Loading more repositories...')).toBeInTheDocument();

    // A repo updated while the pages are read comes back on page 2: listed once.
    await act(async () => releasePage2({ repos: [older, recent], nextPage: null }));
    await typeSearch('older');

    expect(listReposPage.mock.calls).toEqual([[1], [2]]);
    expect(screen.queryByText('Loading more repositories...')).not.toBeInTheDocument();
    fireEvent.click(screen.getByTitle(older.fullName));
    expect(onChange).toHaveBeenCalledWith([older]);
    await typeSearch('');
    expect(screen.getAllByTitle(recent.fullName)).toHaveLength(1);
  });

  it('keeps the pages already read when a later page fails', async () => {
    listReposPage
      .mockResolvedValueOnce({ repos: [recent], nextPage: 2 })
      .mockRejectedValueOnce(new Error('API rate limit exceeded'));
    await renderPicker('github');
    await act(async () => {});

    expect(screen.getByTitle(recent.fullName)).toBeInTheDocument();
    expect(
      screen.getByText('Some repositories could not be loaded. Reopen the picker to try again.'),
    ).toBeInTheDocument();
  });

  it('shows the error when page 1 fails', async () => {
    listReposPage.mockRejectedValueOnce(new Error('GitHub not connected'));
    await renderPicker('github');

    expect(screen.getByText('GitHub not connected')).toBeInTheDocument();
  });

  it('stops at the page cap and says so', async () => {
    listReposPage.mockImplementation(async (page: number) => ({
      repos: [repo(page, `org/r${page}`)],
      nextPage: page + 1,
    }));
    await renderPicker('github');
    await act(async () => {});

    expect(listReposPage).toHaveBeenCalledTimes(10);
    expect(
      screen.getByText('Showing the 1,000 most recently updated repositories.'),
    ).toBeInTheDocument();
  });

  it('lists the GitHub App repositories in one request, without paging', async () => {
    const appRepos = vi.spyOn(
      (await import('@/services/gitProvider')).githubAppService,
      'listRepos',
    );
    appRepos.mockResolvedValue([recent]);
    render(
      <GitRepoSelect
        provider="github"
        repoSource="github-app"
        multiple
        value={[]}
        onChange={() => {}}
      />,
    );
    await act(async () => {});

    expect(screen.getByTitle(recent.fullName)).toBeInTheDocument();
    expect(listReposPage).not.toHaveBeenCalled();
    appRepos.mockRestore();
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
