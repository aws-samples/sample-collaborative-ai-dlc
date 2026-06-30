import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';

// Stub the git-provider status hook + heavy child widgets so the modal renders
// in jsdom without network or Radix portal complexity.
vi.mock('../hooks/useGitProviderStatus', () => ({
  useGitProviderStatus: () => ({
    status: { connected: false },
    loading: false,
    error: null,
    refresh: () => {},
  }),
}));
vi.mock('./GitConnectButton', () => ({ GitConnectButton: () => null }));
vi.mock('./GitRepoSelect', () => ({ GitRepoSelect: () => null }));
vi.mock('../services/projects', () => ({ projectsService: { create: vi.fn() } }));
vi.mock('../services/workflows', () => ({
  workflowsService: { list: vi.fn().mockResolvedValue({ workflows: [] }) },
}));
vi.mock('../services/trackers', () => ({ trackersService: { addToProject: vi.fn() } }));

import { CreateProjectModal } from './CreateProjectModal';

describe('CreateProjectModal', () => {
  it('offers a v1/v2 project-type choice on step 1', () => {
    render(<CreateProjectModal onClose={() => {}} onCreated={() => {}} />);
    expect(screen.getByText('Project Type')).toBeInTheDocument();
    // Both kinds are selectable; the v2 option is labeled with the workflow tagline.
    expect(screen.getByText('Sprint lifecycle')).toBeInTheDocument();
    expect(screen.getByText('AI-DLC v2 workflow')).toBeInTheDocument();
  });
});
