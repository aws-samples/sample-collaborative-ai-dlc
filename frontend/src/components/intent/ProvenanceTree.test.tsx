import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ProvenanceTree } from './ProvenanceTree';
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
  attempt: 0,
  cli: null,
  resolvedModel: null,
  order: 1,
  planned: true,
  ...over,
});

const PHASE_NAMES: Record<string, string> = { '01': 'Inception', '02': 'Construction' };
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
      openArtifactPreview={() => {}}
      openItemPreview={() => {}}
      {...overrides}
    />,
  );

describe('ProvenanceTree — cross-phase stage collision (CHANGE 1)', () => {
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
