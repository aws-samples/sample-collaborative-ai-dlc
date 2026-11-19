import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { IntentArtifact } from '@/services/intents';

const mocks = vi.hoisted(() => ({
  artifact: null as IntentArtifact | null,
  reload: vi.fn(),
}));

vi.mock('@/contexts/IntentContext', () => ({
  INTENT_OUTPUT_KEY: 'intent',
  useIntent: () => ({
    detail: { intent: { id: 'i1' }, events: [], artifacts: mocks.artifact ? [mocks.artifact] : [] },
    projectId: 'p1',
    intentId: 'i1',
    stageRows: [],
    agentFocus: null,
    previewSeq: 1,
    previewArtifactId: 'design',
    previewItemId: null,
    previewAnchor: null,
    clearPreviewAnchor: vi.fn(),
    openArtifactPreview: vi.fn(),
    openItemPreview: vi.fn(),
    reload: mocks.reload,
    outputBuffers: new Map(),
    outputRows: new Map(),
    outputVersion: 0,
    stageNameOf: (key: string) => key,
    ensureOutputs: vi.fn(),
    outputPaneStatus: () => 'seeded',
  }),
}));
vi.mock('@/hooks/useIntentGraph', () => ({
  useIntentGraph: () => ({ derivedItems: [], getNeighbors: () => [] }),
}));
vi.mock('@/components/discussion', () => ({
  DiscussionPanel: () => <div />,
  useDiscussions: () => null,
}));
vi.mock('@/components/discussion/DiscussionsTab', () => ({ DiscussionsTab: () => <div /> }));
vi.mock('@/components/intent/ArtifactEditControls', () => ({
  ArtifactEditControls: () => null,
  ArtifactStaleBadge: () => null,
}));
vi.mock('@/components/intent/ArtifactHistoryDrawer', () => ({ ArtifactHistoryDrawer: () => null }));
vi.mock('@/components/intent/ArtifactContentEditor', () => ({ ArtifactContentEditor: () => null }));
vi.mock('@/components/intent/ArtifactContent', () => ({
  ArtifactContent: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { IntentActivityPanel } from './IntentActivityPanel';

const artifact: IntentArtifact = {
  id: 'design',
  artifactType: 'design',
  title: 'Design',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-design',
  createdAt: '2026-01-01T00:00:00.000Z',
};

describe('IntentActivityPanel artifact preview body states', () => {
  beforeAll(() => {
    // The preview's ScrollArea observes its size; jsdom has no ResizeObserver.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    mocks.reload.mockReset();
  });

  it('says the body is loading, then shows it', () => {
    mocks.artifact = artifact;
    const { rerender } = render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('Loading document…');

    mocks.artifact = { ...artifact, content: '# Design' };
    rerender(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(screen.getByText('# Design')).toBeInTheDocument();
  });

  it('explains a body too large to display', () => {
    mocks.artifact = { ...artifact, content: null, contentUnavailable: 'too_large' };
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByRole('status')).toHaveTextContent('too large to display');
  });

  it('retries a body that failed to load', async () => {
    mocks.artifact = { ...artifact, content: null, contentUnavailable: 'error' };
    render(<IntentActivityPanel onClose={() => {}} />);
    expect(screen.getByRole('alert')).toHaveTextContent("couldn't be loaded");
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(mocks.reload).toHaveBeenCalledTimes(1);
  });
});
