import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub the git-provider status hook + heavy child widgets so the modal renders
// in jsdom without network or Radix portal complexity. The GitRepoSelect stub
// exposes a button that selects one repo, standing in for the provider-backed
// picker.
// Per-test switch: the "App path without OAuth" test flips this to false.
let oauthConnected = true;
vi.mock('../hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({
    status: { connected: oauthConnected },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock('./GitConnectButton', () => ({ GitConnectButton: () => null }));
vi.mock('./GitRepoSelect', () => ({
  GitRepoSelect: ({ onChange }: { onChange: (repos: { fullName: string }[]) => void }) => (
    <button type="button" onClick={() => onChange([{ fullName: 'acme/widgets' }])}>
      select-repo
    </button>
  ),
}));
vi.mock('../services/projects', () => ({
  projectsService: {
    create: vi.fn().mockResolvedValue({ id: 'p1' }),
    delete: vi.fn().mockResolvedValue(undefined),
  },
}));
vi.mock('../services/workflows', () => ({
  workflowsService: {
    list: vi.fn().mockResolvedValue({
      workflows: [
        { workflowId: 'aidlc-v2', name: 'AI-DLC v2' },
        { workflowId: 'custom-flow', name: 'Custom Flow' },
      ],
    }),
  },
}));
vi.mock('../services/trackers', () => ({ trackersService: { addToProject: vi.fn() } }));
vi.mock('../services/gitProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/gitProvider')>();
  return {
    ...actual,
    githubAppService: {
      getStatus: vi.fn().mockResolvedValue({ configured: true }),
      listRepos: vi.fn().mockResolvedValue([]),
    },
  };
});
vi.mock('../services/sourceControl', () => ({
  sourceControlService: {
    bind: vi.fn().mockResolvedValue({ ready: true, repositories: [] }),
  },
}));

import { CreateProjectModal } from './CreateProjectModal';
import { projectsService } from '../services/projects';
import { sourceControlService } from '../services/sourceControl';
import { workflowsService } from '../services/workflows';
import { githubAppService } from '../services/gitProvider';

describe('CreateProjectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    oauthConnected = true;
    vi.mocked(projectsService.create).mockResolvedValue({ id: 'p1' } as never);
    vi.mocked(projectsService.delete).mockResolvedValue(undefined as never);
    vi.mocked(sourceControlService.bind).mockResolvedValue({
      ready: true,
      repositories: [],
    });
    vi.mocked(githubAppService.getStatus).mockResolvedValue({ configured: true });
  });

  // The workflow catalog loads on mount; flush that promise inside act so the
  // resulting state updates don't warn after each test's assertions.
  const renderModal = async (ui: React.ReactElement) => {
    render(ui);
    await act(async () => {});
  };

  it('renders no project-type picker — v2 is the only creatable kind', async () => {
    await renderModal(<CreateProjectModal onClose={() => {}} onCreated={() => {}} />);
    expect(screen.queryByText('Project Type')).not.toBeInTheDocument();
    expect(screen.queryByText('Sprint lifecycle')).not.toBeInTheDocument();
    expect(screen.queryByText('AI-DLC v2 workflow')).not.toBeInTheDocument();
    // Step 1 goes straight to the git-provider choice.
    expect(screen.getByText('Choose Git Provider')).toBeInTheDocument();
  });

  it('loads the workflow catalog on mount (no v2 opt-in needed)', async () => {
    await renderModal(<CreateProjectModal onClose={() => {}} onCreated={() => {}} />);
    expect(workflowsService.list).toHaveBeenCalledTimes(1);
  });

  it('always submits kind v2 with the selected workflow', async () => {
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await renderModal(
      <CreateProjectModal onClose={onClose} onCreated={onCreated} initialProvider="github" />,
    );

    // Step 1: provider preselected + connected → proceed.
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 2: pick a repo via the stubbed selector → proceed.
    await user.click(screen.getByRole('button', { name: 'select-repo' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    // Step 3: the canonical aidlc-v2 workflow is auto-selected once loaded.
    const createBtn = await screen.findByRole('button', { name: 'Create Space' });
    await waitFor(() => expect(createBtn).toBeEnabled());
    await user.click(createBtn);

    await waitFor(() => expect(projectsService.create).toHaveBeenCalledTimes(1));
    expect(projectsService.create).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: 'v2',
        workflowId: 'aidlc-v2',
        gitProvider: 'github',
        gitRepo: 'acme/widgets',
        repos: [{ url: 'acme/widgets', role: 'primary' }],
      }),
    );
    expect(sourceControlService.bind).toHaveBeenCalledWith('p1', {
      github: { authType: 'github-app' },
    });
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it('requires explicit confirmation before delegating OAuth', async () => {
    const user = userEvent.setup();
    await renderModal(
      <CreateProjectModal onClose={() => {}} onCreated={() => {}} initialProvider="github" />,
    );

    // Step 1: switch from the default App path to OAuth delegation.
    await user.click(screen.getByRole('radio', { name: /My GitHub OAuth identity/ }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'select-repo' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));

    const createButton = screen.getByRole('button', { name: 'Create Space' });
    expect(createButton).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: /I confirm that this space may use my connected identity/,
      }),
    );
    expect(createButton).toBeEnabled();
    await user.click(createButton);

    await waitFor(() =>
      expect(sourceControlService.bind).toHaveBeenCalledWith('p1', {
        github: { authType: 'github-oauth', confirmDelegation: true },
      }),
    );
  });

  it('lets an unconnected user create a space via the GitHub App path', async () => {
    oauthConnected = false;
    const user = userEvent.setup();
    const onCreated = vi.fn();
    await renderModal(
      <CreateProjectModal onClose={() => {}} onCreated={onCreated} initialProvider="github" />,
    );

    // App is configured, so Next is enabled despite connected=false.
    const nextButton = screen.getByRole('button', { name: 'Next' });
    await waitFor(() => expect(nextButton).toBeEnabled());
    await user.click(nextButton);
    await user.click(screen.getByRole('button', { name: 'select-repo' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    const createBtn = await screen.findByRole('button', { name: 'Create Space' });
    await waitFor(() => expect(createBtn).toBeEnabled());
    await user.click(createBtn);

    await waitFor(() =>
      expect(sourceControlService.bind).toHaveBeenCalledWith('p1', {
        github: { authType: 'github-app' },
      }),
    );
    expect(onCreated).toHaveBeenCalled();
  });

  it('blocks the App path and falls back to OAuth when the App is unconfigured', async () => {
    vi.mocked(githubAppService.getStatus).mockResolvedValue({ configured: false });
    oauthConnected = false;
    await renderModal(
      <CreateProjectModal onClose={() => {}} onCreated={() => {}} initialProvider="github" />,
    );

    // App option disabled; selection fell back to OAuth, which is not
    // connected — so Next stays disabled.
    await waitFor(() => expect(screen.getByRole('radio', { name: /GitHub App/ })).toBeDisabled());
    expect(screen.getByRole('radio', { name: /My GitHub OAuth identity/ })).toBeChecked();
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
  });

  it('keeps a newly created project (unbound) when binding verification fails', async () => {
    vi.mocked(sourceControlService.bind).mockRejectedValueOnce(
      new Error('GitHub App is not installed for acme/widgets'),
    );
    const user = userEvent.setup();
    const onCreated = vi.fn();
    const onClose = vi.fn();
    await renderModal(
      <CreateProjectModal onClose={onClose} onCreated={onCreated} initialProvider="github" />,
    );

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(screen.getByRole('button', { name: 'select-repo' }));
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await user.click(await screen.findByRole('button', { name: 'Create Space' }));

    // The project survives unbound; the launch guard blocks repository-backed
    // starts until an owner rebinds it in project settings.
    await waitFor(() => expect(onCreated).toHaveBeenCalled());
    expect(projectsService.delete).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
