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
