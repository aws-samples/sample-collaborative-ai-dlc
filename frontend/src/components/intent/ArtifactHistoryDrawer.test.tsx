import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ArtifactVersion, ArtifactVersionSummary, IntentArtifact } from '@/services/intents';

const artifactVersions = vi.fn();
const artifactVersion = vi.fn();
const openArtifactPreview = vi.fn();
const openItemPreview = vi.fn();

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    projectId: 'p1',
    intentId: 'i1',
    openArtifactPreview,
    openItemPreview,
    detail: {
      artifacts: [
        { id: 'architecture', title: 'Architecture', artifactType: 'architecture' },
        { id: 'design', title: 'Application design', artifactType: 'design' },
      ],
    },
  }),
}));

vi.mock('@/hooks/useIntentGraph', () => ({
  useIntentGraph: () => ({
    derivedItems: [
      {
        id: 'item-dec-1',
        type: 'Decision',
        label: 'No new Java services',
        slug: 'dec-no-new-services',
        graphLayer: 'derived',
        artifactId: 'design',
      },
    ],
    itemsByArtifact: new Map(),
    getNeighbors: () => [],
  }),
}));

vi.mock('@/services/intents', () => ({
  intentsService: {
    artifactVersions: (...args: unknown[]) => artifactVersions(...args),
    artifactVersion: (...args: unknown[]) => artifactVersion(...args),
  },
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

  it('shows version dates as relative time, never as a locale date string', async () => {
    const user = userEvent.setup();
    const { baseElement } = render(<ArtifactHistoryDrawer artifact={artifact} />);

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    await screen.findByText('Current body');

    expect(baseElement.querySelector('time[datetime="2026-01-02T00:00:00.000Z"]')).not.toBeNull();
    expect(baseElement.querySelector('time[datetime="2026-01-03T00:00:00.000Z"]')).not.toBeNull();
    expect(screen.queryByText(/1\/2\/2026|1\/3\/2026/)).not.toBeInTheDocument();
  });

  it('keeps version ids and hashes behind Technical details', async () => {
    const user = userEvent.setup();
    render(<ArtifactHistoryDrawer artifact={artifact} />);

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    await user.click(await screen.findByRole('button', { name: /Generation 1/ }));
    await screen.findByText('Archived body');

    expect(screen.queryByText('design:v1')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /technical details/i }));
    expect(screen.getByText('design:v1')).toBeInTheDocument();
    expect(screen.getByText('abc')).toBeInTheDocument();
  });

  it('renders [[wiki-links]] as clickable references to documents and items', async () => {
    const user = userEvent.setup();
    render(
      <ArtifactHistoryDrawer
        artifact={{
          ...artifact,
          content: 'Builds on [[architecture]] and [[dec-no-new-services]]; see [[unknown-thing]].',
        }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    await user.click(await screen.findByRole('link', { name: 'Architecture' }));
    expect(openArtifactPreview).toHaveBeenCalledWith('architecture');
    await user.click(screen.getByRole('link', { name: 'No new Java services' }));
    expect(openItemPreview).toHaveBeenCalledWith('item-dec-1');
    expect(screen.getByText(/unknown-thing/)).toBeInTheDocument();
  });

  it('renders a structured YAML block as a readable list instead of raw code', async () => {
    const user = userEvent.setup();
    const content = [
      '## Overview',
      '',
      'Decisions recorded for the badge.',
      '',
      '```yaml',
      'decisions:',
      '  - id: dec-no-new-services',
      "    title: 'No new Java services or controllers'",
      '    status: accepted',
      "    context: 'The badge needs cart item count data: read it from the model.'",
      '    tags: [cart, badge]',
      '    consequences:',
      "      - 'Minimal blast radius'",
      "      - 'No new API surface'",
      '  - id: dec-layout-fragment-placement',
      "    title: 'Place badge markup in the shared layout fragment'",
      '    status: proposed',
      '```',
      '',
      'Trailing prose.',
    ].join('\n');
    render(<ArtifactHistoryDrawer artifact={{ ...artifact, content }} />);

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    expect(await screen.findByText('Decisions recorded for the badge.')).toBeInTheDocument();
    expect(screen.getByText('Trailing prose.')).toBeInTheDocument();

    expect(screen.queryByText(/- id: dec-no-new-services/)).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: /Decisions \(2\)/ })).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'No new Java services or controllers' }),
    ).toBeInTheDocument();
    expect(screen.getByText('accepted')).toBeInTheDocument();
    expect(
      screen.getByText('The badge needs cart item count data: read it from the model.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Minimal blast radius')).toBeInTheDocument();
    expect(screen.getByText('cart, badge')).toBeInTheDocument();
    expect(screen.getByText('Context')).toBeInTheDocument();
  });

  it('shows the current body as loading until it arrives', async () => {
    const user = userEvent.setup();
    render(<ArtifactHistoryDrawer artifact={{ ...artifact, content: undefined }} />);

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    expect(await screen.findByText('Loading version')).toBeInTheDocument();
    expect(screen.queryByText('No content recorded.')).not.toBeInTheDocument();
  });

  it('explains a current body that is too large instead of showing it as empty', async () => {
    const user = userEvent.setup();
    render(
      <ArtifactHistoryDrawer
        artifact={{ ...artifact, content: null, contentUnavailable: 'too_large' }}
      />,
    );

    await user.click(screen.getByRole('button', { name: 'History for Application design' }));
    expect(
      await screen.findByText('This version is too large to display here.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('No content recorded.')).not.toBeInTheDocument();
  });
});
