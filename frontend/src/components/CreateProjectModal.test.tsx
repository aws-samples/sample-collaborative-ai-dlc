import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

// Stub the git-provider status hook + heavy child widgets so the modal renders
// in jsdom without network or Radix portal complexity. The GitRepoSelect stub
// exposes a button that selects one repo, standing in for the provider-backed
// picker.
vi.mock('../hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({
    status: { connected: true },
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
  projectsService: { create: vi.fn().mockResolvedValue({ id: 'p1' }) },
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

import { CreateProjectModal } from './CreateProjectModal';
import { projectsService } from '../services/projects';
import { workflowsService } from '../services/workflows';

describe('CreateProjectModal', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    const createBtn = await screen.findByRole('button', { name: 'Create Project' });
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
    expect(onCreated).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });
});
