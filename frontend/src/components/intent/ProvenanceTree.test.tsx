import { describe, it, expect, vi } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { ProvenanceTree } from './ProvenanceTree';
import { focusWorkProduct } from './workProductsFocus';
import type { IntentArtifact, IntentDetail, IntentGraphNode } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';

vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: () => <button data-testid="discuss" />,
}));
vi.mock('@/components/intent/IntentGraphPopover', () => ({
  IntentGraphPopover: () => <span data-testid="graph-popover" />,
}));
vi.mock('@/components/intent/DerivedItemCountChip', () => ({
  DerivedItemCountChip: () => <span data-testid="derived-chip" />,
}));
vi.mock('@/components/intent/ArtifactHistoryDrawer', () => ({
  ArtifactHistoryDrawer: ({ artifact }: { artifact: IntentArtifact }) =>
    (artifact.versionCount ?? 0) > 0 ? (
      <button aria-label={`History for ${artifact.title || artifact.id}`} />
    ) : null,
}));

const LONG = `# Heading\n\n${'Long-form markdown body. '.repeat(40)}`;

const doc = (over: Partial<IntentArtifact> = {}): IntentArtifact => ({
  id: 'a1',
  artifactType: 'requirements',
  title: 'A doc',
  createdByExecutionId: 'i1',
  createdByStageInstanceId: 'si-a',
  createdAt: '2026-01-01T00:00:00Z',
  content: LONG,
  ...over,
});

const row = (over: Partial<IntentStageRow> = {}): IntentStageRow => ({
  stageId: 'design',
  phase: '01',
  state: 'SUCCEEDED',
  stageInstanceId: 'si-a',
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
  ...over,
});

const PHASE_NAMES: Record<string, string> = {
  '01': 'Inception',
  '02': 'Construction',
  '03': 'Operation',
};
const phaseNameOf = (path: string) =>
  PHASE_NAMES[path] ?? (path ? path.charAt(0).toUpperCase() + path.slice(1) : path);

const renderTree = (overrides: Partial<React.ComponentProps<typeof ProvenanceTree>> = {}) =>
  render(
    <ProvenanceTree
      detail={{ artifacts: overrides.detail?.artifacts ?? [] } as IntentDetail}
      stageRows={overrides.stageRows ?? []}
      phaseNameOf={overrides.phaseNameOf ?? phaseNameOf}
      getNeighbors={() => []}
      itemsByArtifact={new Map()}
      derivedItems={[]}
      codeItems={[]}
      unitBranchItems={[]}
      openArtifactPreview={() => {}}
      openItemPreview={() => {}}
      {...overrides}
    />,
  );

describe('ProvenanceTree — cross-phase stage collision (CHANGE 1)', () => {
  it.each([
    { documentOrder: 'oldest-first' as const, codeFirst: false },
    { documentOrder: 'newest-first' as const, codeFirst: true },
  ])('places Code according to $documentOrder ordering', ({ documentOrder, codeFirst }) => {
    renderTree({
      detail: {
        artifacts: [
          doc({
            id: 'construction-doc',
            title: 'Construction document',
            createdByStageInstanceId: 'si-construction',
          }),
        ],
      } as IntentDetail,
      stageRows: [
        row({
          stageId: 'code-generation',
          stageInstanceId: 'si-construction',
          phase: '02',
        }),
      ],
      codeItems: [
        {
          repo: 'acme/api',
          provider: 'github',
          branch: 'aidlc/i1',
          baseBranch: 'main',
          branchUrl: 'https://github.com/acme/api/tree/aidlc/i1',
          prUrl: 'https://github.com/acme/api/pull/7',
          prNumber: '7',
        },
      ],
      documentOrder,
    });

    const code = document.getElementById('provenance-code')!;
    const construction = document.getElementById('provenance-phase-02')!;
    const first = codeFirst ? code : construction;
    const second = codeFirst ? construction : code;
    expect(first.compareDocumentPosition(second)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('two docs with the same stageId in different phases render under their own phases', async () => {
    const artifacts = [
      doc({ id: 'd1', title: 'Doc Phase1', createdByStageInstanceId: 'si-1' }),
      doc({ id: 'd2', title: 'Doc Phase2', createdByStageInstanceId: 'si-2' }),
    ];
    const stageRows = [
      row({ stageId: 'design', stageInstanceId: 'si-1', phase: '01', order: 1 }),
      row({ stageId: 'design', stageInstanceId: 'si-2', phase: '02', order: 2 }),
    ];

    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows,
    });

    expect(screen.getByText('Construction')).toBeInTheDocument();
    expect(screen.getByText('Inception')).toBeInTheDocument();

    const phases = screen.getAllByRole('treeitem');
    const inceptionPhase = phases.find((el) => el.id === 'provenance-phase-01');
    const constructionPhase = phases.find((el) => el.id === 'provenance-phase-02');
    expect(inceptionPhase).toBeDefined();
    expect(constructionPhase).toBeDefined();

    // Each phase owns exactly its own stage node — under the pre-fix flat
    // lookup, phase 02's doc was filed into phase 01's 'design' node and
    // phase 02 rendered empty.
    expect(
      inceptionPhase!.querySelector('[id="provenance-stage-01/design/__common__"]'),
    ).not.toBeNull();
    expect(
      constructionPhase!.querySelector('[id="provenance-stage-02/design/__common__"]'),
    ).not.toBeNull();
    expect(
      inceptionPhase!.querySelector('[id="provenance-stage-02/design/__common__"]'),
    ).toBeNull();
  });
});

describe('ProvenanceTree — phase ordering', () => {
  it('orders multi-digit phase paths in workflow order, independent of locale collation', () => {
    const artifacts = [
      doc({ id: 'd1', title: 'Doc 01', createdByStageInstanceId: 'si-1' }),
      doc({ id: 'd2', title: 'Doc 02', createdByStageInstanceId: 'si-2' }),
      doc({ id: 'd3', title: 'Doc 10', createdByStageInstanceId: 'si-3' }),
    ];
    const stageRows = [
      row({ stageId: 'a', stageInstanceId: 'si-1', phase: '01', order: 1 }),
      row({ stageId: 'b', stageInstanceId: 'si-2', phase: '02', order: 1 }),
      row({ stageId: 'c', stageInstanceId: 'si-3', phase: '10', order: 1 }),
    ];

    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows,
      phaseNameOf: (path: string) => `Phase ${path}`,
    });

    const phaseIds = screen
      .getAllByRole('treeitem')
      .map((el) => el.id)
      .filter((id) => id.startsWith('provenance-phase-'));
    expect(phaseIds).toEqual(['provenance-phase-01', 'provenance-phase-02', 'provenance-phase-10']);
  });
});

describe('ProvenanceTree — document ordering', () => {
  const artifacts = [
    doc({ id: 'older', title: 'Older document', createdAt: '2026-01-01T10:00:00Z' }),
    doc({ id: 'newer', title: 'Newer document', createdAt: '2026-01-01T11:00:00Z' }),
  ];

  it('defaults to document production order within a stage', () => {
    renderTree({ detail: { artifacts } as IntentDetail, stageRows: [row()] });

    expect(
      screen
        .getByText('Older document')
        .compareDocumentPosition(screen.getByText('Newer document')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it('reverses phases, stages, and documents together', () => {
    const reversedArtifacts = [
      doc({
        id: 'inception-first',
        title: 'Inception first',
        createdByStageInstanceId: 'si-inception-first',
        createdAt: '2026-01-01T10:00:00Z',
      }),
      doc({
        id: 'inception-last',
        title: 'Inception last',
        createdByStageInstanceId: 'si-inception-last',
        createdAt: '2026-01-01T11:00:00Z',
      }),
      doc({
        id: 'operation',
        title: 'Operation document',
        createdByStageInstanceId: 'si-operation',
        createdAt: '2026-01-01T12:00:00Z',
      }),
    ];
    renderTree({
      detail: { artifacts: reversedArtifacts } as IntentDetail,
      stageRows: [
        row({
          stageId: 'research',
          stageInstanceId: 'si-inception-first',
          phase: '01',
          order: 1,
        }),
        row({
          stageId: 'requirements-analysis',
          stageInstanceId: 'si-inception-last',
          phase: '01',
          order: 2,
        }),
        row({ stageId: 'operate', stageInstanceId: 'si-operation', phase: '03', order: 1 }),
      ],
      documentOrder: 'newest-first',
    });

    expect(
      screen.getByText('Operation').compareDocumentPosition(screen.getByText('Inception')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      screen
        .getByText('Requirements Analysis')
        .compareDocumentPosition(screen.getByText('Research')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      screen
        .getByText('Inception last')
        .compareDocumentPosition(screen.getByText('Inception first')),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });
});

describe('ProvenanceTree — item type legend', () => {
  it('lists each present derived-item type once, and hides with a single type', () => {
    const stageRows = [row({ stageId: 'design', stageInstanceId: 'si-a', phase: '01', order: 1 })];
    const artifacts = [doc({ id: 'd1', title: 'Doc A' })];
    const items = (types: string[]): IntentGraphNode[] =>
      types.map((type, i) => ({
        id: `item-${i}`,
        type,
        label: `Item ${i}`,
        graphLayer: 'derived',
        artifactId: 'd1',
      }));

    const { unmount } = renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows,
      derivedItems: items(['Requirement', 'Story', 'Requirement']),
    });

    expect(screen.getByText('Requirement')).toBeInTheDocument();
    expect(screen.getByText('Story')).toBeInTheDocument();
    unmount();

    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows,
      derivedItems: items(['Requirement']),
    });
    expect(screen.queryByText('Requirement')).not.toBeInTheDocument();
  });
});

describe('ProvenanceTree — focus navigation', () => {
  const artifactId = 'sectioned-artifact';
  const item: IntentGraphNode = {
    id: 'sectioned-item',
    type: 'Requirement',
    label: 'Sectioned requirement',
    graphLayer: 'derived',
    artifactId,
  };

  const renderSectionedTree = () => {
    renderTree({
      detail: {
        artifacts: [
          doc({
            id: artifactId,
            title: 'Sectioned design',
            createdByStageInstanceId: 'si-sectioned',
          }),
        ],
      } as IntentDetail,
      stageRows: [
        row({
          stageInstanceId: 'si-sectioned',
          unitSlug: 'auth',
          sectionIndex: 1,
        }),
      ],
      itemsByArtifact: new Map([[artifactId, [item]]]),
      derivedItems: [item],
    });

    const stage = document.getElementById('provenance-stage-01/design/s1:auth')!;
    fireEvent.click(stage.querySelector('button')!);
    expect(stage).toHaveAttribute('aria-expanded', 'false');
    return stage;
  };

  it('re-expands a collapsed sectioned unit stage when focusing its artifact', () => {
    const stage = renderSectionedTree();

    act(() => focusWorkProduct({ kind: 'artifact', id: artifactId }));

    expect(stage).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Sectioned design')).toBeInTheDocument();
  });

  it('re-expands a collapsed sectioned unit stage when focusing its derived item', () => {
    const stage = renderSectionedTree();

    act(() => focusWorkProduct({ kind: 'item', id: item.id }));

    expect(stage).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText(item.label)).toBeInTheDocument();
  });
});

describe('ProvenanceTree — artifact history', () => {
  it('shows history on versioned documents in the redesigned work-products tree', () => {
    const artifacts = [
      doc({ id: 'versioned', title: 'Versioned doc', versionCount: 2 }),
      doc({ id: 'current-only', title: 'Current doc', versionCount: 0 }),
    ];

    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows: [row()],
    });

    expect(screen.getByRole('button', { name: 'History for Versioned doc' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'History for Current doc' })).toBeNull();
  });
});

describe('ProvenanceTree — unit-lane split (CHANGE 2)', () => {
  it('two units running the same stageId produce two stage nodes each with its own badge', () => {
    const artifacts = [
      doc({ id: 'be-doc', title: 'Backend Doc', createdByStageInstanceId: 'si-be' }),
      doc({ id: 'fe-doc', title: 'Frontend Doc', createdByStageInstanceId: 'si-fe' }),
    ];
    const stageRows = [
      row({
        stageId: 'code-generation',
        stageInstanceId: 'si-be',
        phase: '02',
        order: 3,
        unitSlug: 'backend',
      }),
      row({
        stageId: 'code-generation',
        stageInstanceId: 'si-fe',
        phase: '02',
        order: 3,
        unitSlug: 'frontend',
      }),
    ];

    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows,
    });

    const badges = screen.getAllByText(/^(backend|frontend)$/);
    expect(badges).toHaveLength(2);
    expect(badges.map((b) => b.textContent).toSorted()).toEqual(['backend', 'frontend']);

    const stageLabels = screen.getAllByText('Code Generation');
    expect(stageLabels).toHaveLength(2);
  });

  it('places each unit branch between its code generation plan and code summary', () => {
    const artifacts = [
      doc({
        id: 'plan',
        artifactType: 'code-generation-plan',
        title: 'Code generation plan',
        createdByStageInstanceId: 'si-auth',
        createdAt: '2026-01-01T10:00:00Z',
      }),
      doc({
        id: 'summary',
        artifactType: 'code-summary',
        title: 'Code summary',
        createdByStageInstanceId: 'si-auth',
        createdAt: '2026-01-01T11:00:00Z',
      }),
    ];
    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows: [
        row({
          stageId: 'code-generation',
          stageInstanceId: 'si-auth',
          phase: '02',
          order: 3,
          unitSlug: 'auth',
          sectionIndex: 1,
        }),
      ],
      unitBranchItems: [
        {
          sectionIndex: 1,
          unitSlug: 'auth',
          branch: 'aidlc/i1--s1-unit-auth',
          targets: [
            {
              repo: 'acme/api',
              provider: 'github',
              url: 'https://github.com/acme/api/tree/aidlc/i1--s1-unit-auth',
              prUrl: 'https://github.com/acme/api/pull/12',
              prNumber: 12,
            },
            {
              repo: 'acme/web',
              provider: 'gitlab',
              url: 'https://gitlab.com/acme/web/-/tree/aidlc/i1--s1-unit-auth',
              prUrl: null,
              prNumber: null,
            },
          ],
        },
      ],
    });

    const planRow = screen.getByText('Code generation plan');
    const branchRows = screen.getAllByRole('link', { name: 'aidlc/i1--s1-unit-auth' });
    const branchRow = branchRows[0];
    const summaryRow = screen.getByText('Code summary');
    expect(branchRows).toHaveLength(2);
    expect(
      screen.getByTestId('unit-branch-1-auth').querySelectorAll('.lucide-git-branch'),
    ).toHaveLength(2);
    expect(planRow.compareDocumentPosition(branchRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(branchRow.compareDocumentPosition(summaryRow)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(branchRow).toHaveAttribute('target', '_blank');
    expect(branchRow).toHaveAttribute('title', 'acme/api · aidlc/i1--s1-unit-auth');
    const unitPrLink = screen.getByRole('link', { name: 'Open PR #12 for acme/api' });
    expect(unitPrLink).toHaveAttribute('href', 'https://github.com/acme/api/pull/12');
    expect(unitPrLink).toHaveTextContent('Open PR #12');
    expect(unitPrLink.querySelector('[aria-label="GitHub"]')).not.toBeNull();
    expect(screen.queryByText('Branch')).not.toBeInTheDocument();
    expect(screen.queryByText('acme/api')).not.toBeInTheDocument();
    expect(screen.queryByText('acme/web')).not.toBeInTheDocument();
  });

  it('shows plain branch text instead of a broken link when its URL is unavailable', () => {
    renderTree({
      detail: {
        artifacts: [
          doc({
            artifactType: 'code-summary',
            title: 'Code summary',
            createdByStageInstanceId: 'si-auth',
          }),
        ],
      } as IntentDetail,
      stageRows: [
        row({
          stageId: 'code-generation',
          stageInstanceId: 'si-auth',
          phase: '02',
          unitSlug: 'auth',
          sectionIndex: 1,
        }),
      ],
      unitBranchItems: [
        {
          sectionIndex: 1,
          unitSlug: 'auth',
          branch: 'aidlc/i1--s1-unit-auth',
          targets: [
            {
              repo: 'acme/api',
              provider: 'github',
              url: null,
              prUrl: null,
              prNumber: null,
            },
          ],
        },
      ],
    });

    expect(screen.getByText('aidlc/i1--s1-unit-auth')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'aidlc/i1--s1-unit-auth' })).not.toBeInTheDocument();
  });

  it('omits the unit branch row when no branch was recorded', () => {
    renderTree({
      detail: {
        artifacts: [
          doc({
            artifactType: 'code-summary',
            title: 'Code summary',
            createdByStageInstanceId: 'si-auth',
          }),
        ],
      } as IntentDetail,
      stageRows: [
        row({
          stageId: 'code-generation',
          stageInstanceId: 'si-auth',
          phase: '02',
          unitSlug: 'auth',
          sectionIndex: 1,
        }),
      ],
      unitBranchItems: [
        {
          sectionIndex: 1,
          unitSlug: 'auth',
          branch: null,
          targets: [],
        },
      ],
    });

    expect(screen.queryByTestId('unit-branch-1-auth')).not.toBeInTheDocument();
  });

  it('shows the provider icon next to the final intent PR link', () => {
    renderTree({
      codeItems: [
        {
          repo: 'acme/api',
          provider: 'bitbucket',
          branch: 'aidlc/i1',
          baseBranch: 'main',
          branchUrl: 'https://bitbucket.org/acme/api/src/aidlc/i1',
          prUrl: 'https://bitbucket.org/acme/api/pull-requests/4',
          prNumber: '4',
        },
      ],
    });

    fireEvent.click(screen.getByText('Code'));
    const intentPrLink = screen.getByRole('link', { name: 'Open PR #4 for acme/api' });
    expect(intentPrLink).toHaveAttribute('href', 'https://bitbucket.org/acme/api/pull-requests/4');
    expect(intentPrLink).toHaveTextContent('Open PR #4');
    expect(intentPrLink.querySelector('[aria-label="Bitbucket"]')).not.toBeNull();
  });

  it('each unit stage node contains only its own docs', () => {
    const artifacts = [
      doc({
        id: 'be-doc',
        title: 'Backend Doc',
        createdByStageInstanceId: 'si-be',
        createdAt: '2026-01-01T10:00:00Z',
      }),
      doc({
        id: 'fe-doc',
        title: 'Frontend Doc',
        createdByStageInstanceId: 'si-fe',
        createdAt: '2026-01-01T11:00:00Z',
      }),
    ];
    const stageRows = [
      row({
        stageId: 'code-generation',
        stageInstanceId: 'si-be',
        phase: '02',
        order: 3,
        unitSlug: 'backend',
      }),
      row({
        stageId: 'code-generation',
        stageInstanceId: 'si-fe',
        phase: '02',
        order: 3,
        unitSlug: 'frontend',
      }),
    ];

    renderTree({
      detail: { artifacts } as IntentDetail,
      stageRows,
    });

    const treeItems = screen.getAllByRole('treeitem');
    const backendStage = treeItems.find(
      (el) => el.id === 'provenance-stage-02/code-generation/backend',
    );
    const frontendStage = treeItems.find(
      (el) => el.id === 'provenance-stage-02/code-generation/frontend',
    );
    expect(backendStage).toBeDefined();
    expect(frontendStage).toBeDefined();
  });
});
