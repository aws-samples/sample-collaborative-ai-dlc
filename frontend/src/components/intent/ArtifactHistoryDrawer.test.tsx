import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactVersion, ArtifactVersionSummary, IntentArtifact } from '@/services/intents';

const artifactVersions = vi.fn();
const artifactVersion = vi.fn();

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ projectId: 'p1', intentId: 'i1' }),
}));

vi.mock('@/services/intents', () => ({
  intentsService: {
    artifactVersions: (...args: unknown[]) => artifactVersions(...args),
    artifactVersion: (...args: unknown[]) => artifactVersion(...args),
  },
}));

vi.mock('@/components/intent/ArtifactMarkdown', () => ({
  ArtifactMarkdown: ({ content }: { content: string }) => <div>{content}</div>,
}));

import { ArtifactHistoryDrawer } from './ArtifactHistoryDrawer';

const artifact: IntentArtifact = {
  id: 'design',
  artifactType: 'design',
  title: 'Application design',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-design',
  generation: 2,
  versionCount: 1,
  createdAt: '2026-01-03T00:00:00.000Z',
  content: 'Current body',
};

const current: ArtifactVersionSummary = {
  versionId: 'current',
  artifactId: 'design',
  generation: 2,
  artifactType: 'design',
  title: 'Application design',
  stageInstanceId: 'si-design',
  stageAttempt: 1,
  sectionIndex: null,
  unitSlug: null,
  archivedAt: null,
  restartId: null,
  restartReason: null,
  actor: null,
  createdAt: '2026-01-03T00:00:00.000Z',
  editedAt: null,
  editedByName: null,
  contentLength: 12,
  contentType: 'text/markdown',
  contentHash: null,
  legacy: false,
  current: true,
};

const archived: ArtifactVersionSummary = {
  ...current,
  versionId: 'design:v1',
  generation: 1,
  stageAttempt: 0,
  archivedAt: '2026-01-02T00:00:00.000Z',
  restartId: 'restart-1',
  restartReason: 'Retry from design',
  actor: 'Ada',
  createdAt: '2026-01-01T00:00:00.000Z',
  contentLength: 13,
  contentHash: 'abc',
  current: false,
};

describe('ArtifactHistoryDrawer', () => {
  beforeAll(() => {
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      },
    );
  });

  afterAll(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    artifactVersions.mockReset().mockResolvedValue({
      artifactId: 'design',
      current,
      versions: [archived],
    });
    artifactVersion.mockReset().mockResolvedValue({
      ...archived,
      content: 'Archived body',
      relationships: [],
      editedBy: null,
      editOrigin: null,
      verifiedBy: null,
      verifiedByName: null,
      verifiedAt: null,
    } satisfies ArtifactVersion);
  });

  it('does not render or require intent context without archived versions', () => {
    const { container } = render(
      <ArtifactHistoryDrawer artifact={{ ...artifact, versionCount: 0 }} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('loads and renders archived content read-only', async () => {
    const user = userEvent.setup();
    render(<ArtifactHistoryDrawer artifact={artifact} />);

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    expect(await screen.findByText('Current body')).toBeInTheDocument();
    expect(artifactVersions).toHaveBeenCalledWith('p1', 'i1', 'design');

    await user.click(screen.getByRole('button', { name: /Generation 1/ }));
    expect(await screen.findByText('Archived body')).toBeInTheDocument();
    expect(artifactVersion).toHaveBeenCalledWith('p1', 'i1', 'design', 'design:v1');
    expect(screen.queryByRole('button', { name: /restore|edit/i })).not.toBeInTheDocument();
  });
});
