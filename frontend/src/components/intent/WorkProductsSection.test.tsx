import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@/test/query';
import type { IntentArtifact, IntentDetail } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';

const stageRows: IntentStageRow[] = [
  {
    stageId: 'research',
    phase: '01',
    state: 'SUCCEEDED',
    stageInstanceId: 'si-research',
    unitSlug: null,
    runtimeError: null,
    startedAt: null,
    completedAt: null,
    waitMs: 0,
    parkedAt: null,
    pendingHumanTaskId: null,
    attempt: 0,
    cli: null,
    resolvedModel: null,
    order: 1,
    planned: true,
  },
  {
    stageId: 'functional-design',
    phase: '02',
    state: 'SUCCEEDED',
    stageInstanceId: 'si-design',
    unitSlug: null,
    runtimeError: null,
    startedAt: null,
    completedAt: null,
    waitMs: 0,
    parkedAt: null,
    pendingHumanTaskId: null,
    attempt: 0,
    cli: null,
    resolvedModel: null,
    order: 2,
    planned: true,
  },
];

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    openArtifactPreview: vi.fn(),
    openItemPreview: vi.fn(),
    projectId: 'p1',
    intentId: 'i1',
    stageRows,
    phaseNameOf: (path: string) => ({ '01': 'Inception', '02': 'Construction' })[path] ?? path,
  }),
}));
vi.mock('@/hooks/useIntentGraph', () => ({
  useIntentGraph: () => ({ getNeighbors: () => [], derivedItems: [], itemsByArtifact: new Map() }),
}));
vi.mock('@/components/intent/HistorySection', () => ({ HistorySection: () => null }));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button data-testid="discuss" />,
}));
vi.mock('@/components/intent/IntentGraphPopover', () => ({
  IntentGraphPopover: () => <span data-testid="graph-popover" />,
}));
vi.mock('@/components/intent/ArtifactHistoryDrawer', () => ({
  ArtifactHistoryDrawer: () => null,
}));

import { WorkProductsSection, countWorkProductDocuments } from './WorkProductsSection';

const LONG = `# Heading\n\n${'Long-form markdown body. '.repeat(40)}`;

const doc = (id: string, title: string, stage: string, createdAt: string): IntentArtifact => ({
  id,
  artifactType: 'document',
  title,
  createdByExecutionId: 'i1',
  createdByStageInstanceId: stage,
  createdAt,
  content: LONG,
});

const detail = (over: Partial<IntentDetail> = {}): IntentDetail =>
  ({
    intent: { id: 'i1', status: 'SUCCEEDED', scope: 'feature', planWarnings: [] },
    artifacts: [
      doc('a', 'Market research', 'si-research', '2026-01-01T10:00:00Z'),
      doc('b', 'Competitive analysis', 'si-research', '2026-01-01T10:10:00Z'),
      doc('c', 'Feasibility', 'si-research', '2026-01-01T10:20:00Z'),
      doc('d', 'Business logic model', 'si-design', '2026-01-02T10:00:00Z'),
      doc('e', 'Business rules', 'si-design', '2026-01-02T10:10:00Z'),
      doc('f', 'Domain entities', 'si-design', '2026-01-02T10:20:00Z'),
    ],
    events: [],
    steering: [],
    units: [],
    pullRequests: [],
    ...over,
  }) as unknown as IntentDetail;

describe('WorkProductsSection — filter', () => {
  it('filters documents across closed stages and clears back to the default view', () => {
    render(<WorkProductsSection detail={detail()} gates={[]} />);

    // Default: only the newest stage is open.
    expect(screen.getByText('Business rules')).toBeInTheDocument();
    expect(screen.queryByText('Competitive analysis')).not.toBeInTheDocument();

    const input = screen.getByRole('searchbox', { name: 'Filter documents' });
    fireEvent.change(input, { target: { value: 'compet' } });
    expect(screen.getByText('Competitive analysis')).toBeInTheDocument();
    expect(screen.queryByText('Business rules')).not.toBeInTheDocument();

    fireEvent.change(input, { target: { value: '' } });
    expect(screen.getByText('Business rules')).toBeInTheDocument();
    expect(screen.queryByText('Competitive analysis')).not.toBeInTheDocument();
  });

  it('keeps the plan warnings behind a disclosure, without a native details element', () => {
    const { container } = render(
      <WorkProductsSection
        detail={detail({
          intent: {
            id: 'i1',
            status: 'CANCELLED',
            scope: 'feature',
            planWarnings: [{ code: 'skipped', message: 'Operation stages are out of scope.' }],
          },
        } as unknown as Partial<IntentDetail>)}
        gates={[]}
      />,
    );

    expect(container.querySelector('details')).toBeNull();
    expect(
      screen.getByRole('button', { name: /excluded from the Feature scope/ }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Operation stages are out of scope.')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /stages are intentionally excluded/i }));
    expect(screen.getByText('Operation stages are out of scope.')).toBeInTheDocument();
  });
});

describe('WorkProductsSection — nothing produced (R3-16)', () => {
  const empty = (status: string) =>
    detail({
      intent: { id: 'i1', status, scope: 'feature', planWarnings: [] },
      artifacts: [],
    } as unknown as Partial<IntentDetail>);

  it('says that a failed run produced no documents instead of ending after the pipeline', () => {
    render(<WorkProductsSection detail={empty('FAILED')} gates={[]} />);
    expect(screen.getByText('Work products')).toBeInTheDocument();
    expect(
      screen.getByText('No documents were produced before the run failed.'),
    ).toBeInTheDocument();
  });

  it('uses the matching sentence for cancelled and completed runs', () => {
    const { unmount } = render(<WorkProductsSection detail={empty('CANCELLED')} gates={[]} />);
    expect(
      screen.getByText('No documents were produced before the run was cancelled.'),
    ).toBeInTheDocument();
    unmount();
    render(<WorkProductsSection detail={empty('SUCCEEDED')} gates={[]} />);
    expect(screen.getByText('This run produced no documents.')).toBeInTheDocument();
  });

  it('keeps the in-progress placeholder for a live run and stays silent on a draft', () => {
    const { unmount } = render(<WorkProductsSection detail={empty('RUNNING')} gates={[]} />);
    expect(screen.getByText(/No work products yet/)).toBeInTheDocument();
    unmount();
    const { container } = render(<WorkProductsSection detail={empty('DRAFT')} gates={[]} />);
    expect(container).toBeEmptyDOMElement();
  });
});

describe('countWorkProductDocuments', () => {
  it('is the number the Work products header shows (current documents only)', () => {
    const artifacts = [
      ...detail().artifacts,
      { ...doc('g', 'Old draft', 'si-design', '2026-01-03T10:00:00Z'), supersededAt: 'x' },
      {
        ...doc('h', 'tiny', 'si-design', '2026-01-03T10:00:00Z'),
        artifactType: 'diagram',
        content: 'x',
      },
    ] as IntentArtifact[];
    expect(countWorkProductDocuments(artifacts)).toBe(6);
    render(<WorkProductsSection detail={detail({ artifacts })} gates={[]} />);
    expect(screen.getByText('6 documents')).toBeInTheDocument();
  });
});
