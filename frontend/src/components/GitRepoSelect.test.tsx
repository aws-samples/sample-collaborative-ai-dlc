import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import type { GitProvider, GitRepo } from '@/services/gitProvider';
import { GitRepoSelect } from './GitRepoSelect';

const listRepos = vi.hoisted(() => vi.fn());

vi.mock('@/services/gitProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/gitProvider')>();
  return {
    ...actual,
    getGitProviderService: (provider: GitProvider) => ({
      ...actual.getGitProviderService(provider),
      listRepos,
    }),
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
  listRepos.mockReset();
});

const renderPicker = (provider: GitProvider, onChange = vi.fn()) => {
  render(<GitRepoSelect provider={provider} multiple value={[]} onChange={onChange} />);
  return onChange;
};

describe('GitRepoSelect server-side search', () => {
  it('finds a GitLab project beyond the capped list and keeps it selectable', async () => {
    // The unfiltered list stops before the deep project; only search finds it.
    listRepos.mockImplementation((search?: string) => Promise.resolve(search ? [deep] : [recent]));
    const onChange = renderPicker('gitlab');

    const input = await screen.findByPlaceholderText('Search repositories...');
    fireEvent.change(input, { target: { value: 'emu steering' } });

    const option = await screen.findByTitle(deep.fullName);
    expect(listRepos).toHaveBeenCalledWith('emu steering');
    expect(screen.queryByTitle(recent.fullName)).not.toBeInTheDocument();

    fireEvent.click(option);
    expect(onChange).toHaveBeenCalledWith([deep]);
  });

  it('does not search GitLab for terms shorter than three characters', async () => {
    listRepos.mockResolvedValue([recent]);
    renderPicker('gitlab');

    const input = await screen.findByPlaceholderText('Search repositories...');
    fireEvent.change(input, { target: { value: 're' } });

    expect(await screen.findByTitle(recent.fullName)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(listRepos).toHaveBeenCalledTimes(1);
  });

  it('keeps filtering locally for providers without server-side search', async () => {
    listRepos.mockResolvedValue([recent, deep]);
    renderPicker('github');

    const input = await screen.findByPlaceholderText('Search repositories...');
    fireEvent.change(input, { target: { value: 'steering' } });

    await waitFor(() => expect(screen.queryByTitle(recent.fullName)).not.toBeInTheDocument());
    expect(screen.getByTitle(deep.fullName)).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 400));
    expect(listRepos).toHaveBeenCalledTimes(1);
    expect(listRepos).toHaveBeenCalledWith();
  });
});
