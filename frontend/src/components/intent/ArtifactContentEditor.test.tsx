import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentArtifact } from '@/services/intents';

const initContent = vi.fn();
const reload = vi.fn();

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ projectId: 'p1', intentId: 'i1', reload }),
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'Ada' } }),
}));
vi.mock('@/services/intents', () => ({ intentsService: {} }));
vi.mock('@/hooks/useCollaborativeArtifactContent', () => ({
  useCollaborativeArtifactContent: () => ({
    content: '',
    contentText: null,
    initContent,
    synced: true,
    awareness: null,
    remoteUsers: new Map(),
    flush: vi.fn(),
  }),
}));
vi.mock('@/components/CollaborativeTextarea', () => ({
  CollaborativeTextarea: ({
    placeholder,
    disabled,
  }: {
    placeholder: string;
    disabled: boolean;
  }) => <textarea aria-label="content" placeholder={placeholder} disabled={disabled} />,
}));

import { ArtifactContentEditor } from './ArtifactContentEditor';

const artifact: IntentArtifact = {
  id: 'design',
  artifactType: 'design',
  title: 'Design',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-design',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('ArtifactContentEditor', () => {
  beforeEach(() => {
    initContent.mockReset();
    reload.mockReset();
  });

  it('waits for the artifact body before seeding the shared document', () => {
    const { rerender } = render(<ArtifactContentEditor artifact={artifact} onDone={vi.fn()} />);
    expect(initContent).not.toHaveBeenCalled();
    expect(screen.getByLabelText('content')).toBeDisabled();
    expect(screen.getByLabelText('content')).toHaveAttribute('placeholder', 'Loading…');

    rerender(
      <ArtifactContentEditor artifact={{ ...artifact, content: '# Design' }} onDone={vi.fn()} />,
    );
    expect(initContent).toHaveBeenCalledExactlyOnceWith('# Design');
    expect(screen.getByLabelText('content')).toBeEnabled();
  });

  it('never seeds or saves a body that is too large to load', () => {
    render(
      <ArtifactContentEditor
        artifact={{ ...artifact, content: null, contentUnavailable: 'too_large' }}
        onDone={vi.fn()}
      />,
    );
    expect(initContent).not.toHaveBeenCalled();
    expect(screen.getByLabelText('content')).toBeDisabled();
    expect(screen.getByRole('button', { name: /Done/ })).toBeDisabled();
    expect(screen.getByText(/too large to load here/)).toBeInTheDocument();
  });

  it('offers a retry when the body failed to load', () => {
    render(
      <ArtifactContentEditor
        artifact={{ ...artifact, content: null, contentUnavailable: 'error' }}
        onDone={vi.fn()}
      />,
    );
    expect(initContent).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: /Done/ })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(reload).toHaveBeenCalledOnce();
  });
});
