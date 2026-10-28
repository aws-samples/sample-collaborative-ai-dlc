import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

const listIssuePages = vi.fn();
vi.mock('@/services/trackers', () => ({
  trackersService: {
    listIssuePages: (...a: unknown[]) => listIssuePages(...a),
    listComments: vi.fn(),
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

describe('NewIntentPage — tracker picker layout', () => {
  const trackerProject = () =>
    baseProject({
      trackers: [
        {
          id: 't1',
          provider: 'github-issues',
          instance: null,
          externalProjectKey: 'owner/repo',
          displayName: null,
          createdAt: null,
          createdBy: null,
        },
      ],
    });

  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    listBranches
      .mockReset()
      .mockResolvedValue({ branches: ['main', 'develop'], defaultBranch: 'main' });
    listIssuePages.mockReset();
    listIssuePages.mockImplementation(() =>
      (async function* () {
        yield {
          items: [
            {
              resourceId: '1',
              resourceUrl: 'https://github.com/owner/repo/issues/1',
              resourceType: 'issue',
              title: 'Fix login redirect',
              body: null,
              state: 'open',
              labels: [],
              author: { handle: 'someone' },
              createdAt: '2026-10-01T00:00:00Z',
              updatedAt: '2026-10-01T00:00:00Z',
            },
          ],
          totalCount: 1,
          done: true,
        };
      })(),
    );
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: trackerProject(), loading: false });
  });

  it('stretches the issue list to the bottom of the tracker card', async () => {
    renderPage();
    await screen.findByText('Import from tracker');
    const issue = await screen.findByText(/Fix login redirect/);

    // The scrollable list is the direct parent of the issue row buttons.
    const list = issue.closest('button')!.parentElement!;
    expect(list).toHaveClass('max-h-64', 'overflow-y-auto');
    // The card stretches to the grid row height, so below lg the list must be
    // allowed to grow past its 16rem cap and fill the card's remaining space.
    expect(list).toHaveClass('flex-1', 'min-h-0', 'lg:max-h-none');

    // The fill chain must run from the card down to the list, or the list
    // would flex inside a content-sized wrapper and leave white space again.
    const picker = list.parentElement!;
    expect(picker).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
    const cardContent = picker.parentElement!;
    expect(cardContent).toHaveClass('flex', 'min-h-0', 'flex-1', 'flex-col');
    const card = cardContent.parentElement!;
    expect(card).toHaveClass('flex', 'flex-col');
  });
});
