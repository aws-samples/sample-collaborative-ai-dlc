import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { IntentArtifact } from '@/services/intents';

vi.mock('@/components/discussion/DiscussButton', () => ({ DiscussButton: () => null }));
vi.mock('@/components/intent/IntentGraphPopover', () => ({ IntentGraphPopover: () => null }));
vi.mock('@/components/intent/DerivedItemCountChip', () => ({ DerivedItemCountChip: () => null }));
vi.mock('@/components/intent/ArtifactEditControls', () => ({
  ArtifactEditControls: () => null,
  ArtifactStaleBadge: () => null,
}));
vi.mock('@/components/intent/ArtifactHistoryDrawer', () => ({ ArtifactHistoryDrawer: () => null }));
vi.mock('@/components/intent/ArtifactContentEditor', () => ({ ArtifactContentEditor: () => null }));
vi.mock('@/components/intent/ArtifactContent', () => ({
  ArtifactContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { ArtifactViewer } from './ArtifactViewer';

const artifact: IntentArtifact = {
  id: 'design',
  artifactType: 'design',
  title: 'Design',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-design',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ArtifactViewer body states', () => {
  it('says the body is loading until it arrives', () => {
    const { rerender } = render(<ArtifactViewer artifact={artifact} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading document…');

    rerender(<ArtifactViewer artifact={{ ...artifact, content: '# Design' }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('# Design')).toBeInTheDocument();
  });

  it('explains a body too large to display', () => {
    render(
      <ArtifactViewer artifact={{ ...artifact, content: null, contentUnavailable: 'too_large' }} />,
    );
    expect(screen.getByRole('status')).toHaveTextContent('too large to display');
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
  });

  it('offers a retry when the body failed to load', async () => {
    const onRetryContent = vi.fn();
    render(
      <ArtifactViewer
        artifact={{ ...artifact, content: null, contentUnavailable: 'error' }}
        onRetryContent={onRetryContent}
      />,
    );
    expect(screen.getByRole('alert')).toHaveTextContent("couldn't be loaded");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onRetryContent).toHaveBeenCalledTimes(1);
  });

  it('shows nothing extra for an artifact with no body', () => {
    render(<ArtifactViewer artifact={{ ...artifact, content: null }} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
