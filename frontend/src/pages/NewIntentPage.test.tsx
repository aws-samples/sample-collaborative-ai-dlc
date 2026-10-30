import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router';

// Radix Select relies on pointer-capture / scrollIntoView APIs jsdom doesn't
// implement — polyfill just enough for the trigger/option interaction below.
beforeEach(() => {
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

const useProjectCache = vi.fn();
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (...a: unknown[]) => useProjectCache(...a),
}));

const create = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    create: (...a: unknown[]) => create(...a),
  },
}));

const listBranches = vi.fn();
vi.mock('@/services/sourceControl', () => ({
  sourceControlService: {
    listBranches: (...a: unknown[]) => listBranches(...a),
  },
}));

const getTrackerIssue = vi.fn();
const listComments = vi.fn();
const listIssuePages = vi.fn();
vi.mock('@/services/trackers', () => ({
  trackersService: {
    getIssue: (...args: unknown[]) => getTrackerIssue(...args),
    listComments: (...args: unknown[]) => listComments(...args),
    listIssuePages: (...args: unknown[]) => listIssuePages(...args),
  },
}));

import NewIntentPage from './NewIntentPage';

const baseProject = (over: Record<string, unknown> = {}) => ({
  id: 'p1',
  name: 'P',
  gitProvider: 'github',
  gitRepo: 'owner/repo',
  agentCli: 'kiro',
  createdAt: 'T',
  trackers: [],
  repos: [],
  ...over,
});

const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1/intent/new']}>
      <Routes>
        <Route path="/space/:projectId/intent/new" element={<NewIntentPage />} />
        <Route
          path="/space/:projectId/intent/:intentId/compose"
          element={<div data-testid="compose-page" />}
        />
      </Routes>
    </MemoryRouter>,
  );

describe('NewIntentPage — Jira media filenames', () => {
  const issue = (id: string, body = 'List preview') => ({
    resourceId: id,
    title: id,
    body,
    labels: [],
    author: { handle: 'Author' },
    createdAt: '2026-01-01T00:00:00Z',
  });

  beforeEach(() => {
    getTrackerIssue.mockReset();
    listComments.mockReset().mockResolvedValue([]);
    listIssuePages.mockReset().mockImplementation(async function* () {
      yield { items: [issue('PROJ-1'), issue('PROJ-2')], done: true };
    });
    useProjectCache.mockReturnValue({
      project: baseProject({
        trackers: [
          { id: 'jira', provider: 'jira-cloud', instance: 'cloud', externalProjectKey: 'PROJ' },
        ],
      }),
      loading: false,
    });
  });

  it('uses the selected issue with resolved media filenames in the prompt', async () => {
    getTrackerIssue.mockResolvedValue(issue('PROJ-1', 'Before\n\nbrief.pdf\n\nAfter'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /PROJ-1/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue(
        '# PROJ-1\n\nBefore\n\nbrief.pdf\n\nAfter',
      ),
    );
    expect(getTrackerIssue).toHaveBeenCalledExactlyOnceWith('p1', 'jira', 'PROJ-1');
  });

  it('keeps the available issue text when enrichment fails', async () => {
    getTrackerIssue.mockRejectedValue(new Error('Jira unavailable'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /PROJ-1/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue('# PROJ-1\n\nList preview'),
    );
  });

  it('does not overwrite a newer selection when an earlier Jira lookup finishes late', async () => {
    let resolveFirst!: (value: ReturnType<typeof issue>) => void;
    getTrackerIssue
      .mockReturnValueOnce(
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
      )
      .mockResolvedValueOnce(issue('PROJ-2', 'second.pdf'));
    renderPage();
    await userEvent.click(await screen.findByRole('button', { name: /PROJ-1/ }));
    await userEvent.click(await screen.findByRole('button', { name: /PROJ-2/ }));
    await waitFor(() =>
      expect(screen.getByLabelText('Prompt')).toHaveValue('# PROJ-2\n\nsecond.pdf'),
    );
    await act(async () => resolveFirst(issue('PROJ-1', 'first.pdf')));
    expect(screen.getByLabelText('Prompt')).toHaveValue('# PROJ-2\n\nsecond.pdf');
  });
});

describe('NewIntentPage — DRAFT-first creation', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    listBranches
      .mockReset()
      .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject({ repos: [] }), loading: false });
  });

  it('creates the DRAFT without a scope and lands on the compose page', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    // Scope selection moved to the collaborative compose page — the server
    // defaults it at create.
    const payload = create.mock.calls[0][1];
    expect(payload.scope).toBeUndefined();
    expect(await screen.findByTestId('compose-page')).toBeInTheDocument();
  });

  it('a title alone is enough to start a draft (prompt is refined collaboratively)', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.type(await screen.findByLabelText('Title'), 'Add auth');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
  });
});

describe('NewIntentPage — base branch selection', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    listBranches
      .mockReset()
      .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
    useProjectCache.mockReset();
  });

  it('hides the base-branch section for a project with no repos', async () => {
    useProjectCache.mockReturnValue({ project: baseProject({ repos: [] }), loading: false });
    renderPage();
    await screen.findByLabelText('Prompt');
    expect(screen.queryByText('Base branch')).not.toBeInTheDocument();
  });

  it('shows a collapsed base-branch section for a project with repos, and never fetches branches unless expanded', async () => {
    useProjectCache.mockReturnValue({
      project: baseProject({ repos: [{ url: 'owner/repo', role: 'primary' }] }),
      loading: false,
    });
    renderPage();
    expect(await screen.findByText('Base branch')).toBeInTheDocument();
    expect(listBranches).not.toHaveBeenCalled();
  });

  it('fetches each repo branch list once the section is expanded', async () => {
    const user = userEvent.setup();
    useProjectCache.mockReturnValue({
      project: baseProject({
        repos: [
          { url: 'owner/repo', role: 'primary' },
          { url: 'owner/web', role: 'secondary' },
        ],
      }),
      loading: false,
    });
    renderPage();
    await user.click(await screen.findByText('Base branch'));
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));
    expect(listBranches).toHaveBeenCalledWith('p1', 'github', 'owner/repo');
    expect(listBranches).toHaveBeenCalledWith('p1', 'github', 'owner/web');
    expect(await screen.findByLabelText('owner/repo')).toBeInTheDocument();
    expect(await screen.findByLabelText('owner/web')).toBeInTheDocument();
  });

  it('creates the intent WITHOUT baseBranches when the picker is never touched', async () => {
    const user = userEvent.setup();
    useProjectCache.mockReturnValue({
      project: baseProject({ repos: [{ url: 'owner/repo', role: 'primary' }] }),
      loading: false,
    });
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][1];
    expect(payload.baseBranches).toBeUndefined();
  });

  it('includes only the explicitly-picked repo in baseBranches on submit', async () => {
    const user = userEvent.setup();
    useProjectCache.mockReturnValue({
      project: baseProject({
        repos: [
          { url: 'owner/repo', role: 'primary' },
          { url: 'owner/web', role: 'secondary' },
        ],
      }),
      loading: false,
    });
    renderPage();
    await user.type(await screen.findByLabelText('Prompt'), 'Build X');
    await user.click(await screen.findByText('Base branch'));
    await waitFor(() => expect(listBranches).toHaveBeenCalledTimes(2));

    const repoSelect = await screen.findByLabelText('owner/repo');
    await user.click(repoSelect);
    const option = await screen.findByRole('option', { name: /^develop$/ });
    await user.click(option);

    const submit = screen.getByRole('button', { name: /continue to compose/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][1];
    expect(payload.baseBranches).toEqual({ 'owner/repo': 'develop' });
  });
});
