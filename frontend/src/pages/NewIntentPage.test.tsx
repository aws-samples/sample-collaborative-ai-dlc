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

const compiled = vi.fn();
const executionPreview = vi.fn();
vi.mock('@/services/workflows', () => ({
  workflowsService: {
    compiled: (...a: unknown[]) => compiled(...a),
    executionPreview: (...a: unknown[]) => executionPreview(...a),
  },
}));

const listBranches = vi.fn();
vi.mock('@/services/gitProvider', () => ({
  getGitProviderService: () => ({
    listBranches: (...a: unknown[]) => listBranches(...a),
  }),
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
    <MemoryRouter initialEntries={['/project/p1/intent/new']}>
      <Routes>
        <Route path="/project/:projectId/intent/new" element={<NewIntentPage />} />
      </Routes>
    </MemoryRouter>,
  );

describe('NewIntentPage — base branch selection', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    compiled.mockReset().mockResolvedValue({ scopeGrid: { feature: {} } });
    executionPreview.mockReset().mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
      plan: { stages: [], summary: null },
    });
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
    expect(listBranches).toHaveBeenCalledWith('owner/repo');
    expect(listBranches).toHaveBeenCalledWith('owner/web');
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
    const submit = screen.getByRole('button', { name: /create intent/i });
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

    const submit = screen.getByRole('button', { name: /create intent/i });
    await waitFor(() => expect(submit).toBeEnabled());
    await user.click(submit);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const payload = create.mock.calls[0][1];
    expect(payload.baseBranches).toEqual({ 'owner/repo': 'develop' });
  });
});

// Upstream 2.2.11: scope confirmation shows the EXACT run shape ("N of T
// stages, G approval gates" + fan-out clause), read verbatim from the plan
// preview's summary — never re-derived client-side.
describe('NewIntentPage — scope run-shape summary', () => {
  beforeEach(() => {
    create.mockReset().mockResolvedValue({ id: 'i1' });
    compiled.mockReset().mockResolvedValue({ scopeGrid: { feature: {} } });
    executionPreview.mockReset();
    listBranches.mockReset().mockResolvedValue({ branches: ['main'], defaultBranch: 'main' });
    useProjectCache.mockReset();
    useProjectCache.mockReturnValue({ project: baseProject({ repos: [] }), loading: false });
  });

  it('renders the exact stage/gate counts from the preview summary', async () => {
    executionPreview.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
      plan: {
        stages: [],
        summary: {
          executedStages: 24,
          totalStages: 32,
          approvalGates: 18,
          perUnitStages: 5,
          skippedStages: 0,
          outOfScopeStages: 8,
        },
      },
    });
    renderPage();
    const summary = await screen.findByTestId('scope-summary');
    expect(summary.textContent).toContain('Runs 24 of 32 stages');
    expect(summary.textContent).toContain('18 approval gates');
    expect(summary.textContent).toContain('5 stages fan out per unit of work');
    expect(executionPreview).toHaveBeenCalledWith('aidlc-v2', 'feature', undefined);
  });

  it('singularizes the counts and drops the fan-out clause when nothing fans out', async () => {
    executionPreview.mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [],
      plan: {
        stages: [],
        summary: {
          executedStages: 3,
          totalStages: 5,
          approvalGates: 1,
          perUnitStages: 0,
          skippedStages: 0,
          outOfScopeStages: 2,
        },
      },
    });
    renderPage();
    const summary = await screen.findByTestId('scope-summary');
    expect(summary.textContent).toContain('1 approval gate');
    expect(summary.textContent).not.toContain('approval gates');
    expect(summary.textContent).not.toContain('per unit of work');
  });

  it('shows no summary line when the preview fails (best-effort sugar)', async () => {
    executionPreview.mockRejectedValue(new Error('boom'));
    renderPage();
    await screen.findByLabelText('Prompt');
    await waitFor(() => expect(executionPreview).toHaveBeenCalled());
    expect(screen.queryByTestId('scope-summary')).not.toBeInTheDocument();
  });
});
