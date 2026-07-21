import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

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
