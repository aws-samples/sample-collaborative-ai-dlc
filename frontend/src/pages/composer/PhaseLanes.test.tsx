import { describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { PhaseLanes } from './PhaseLanes';
import type { Block } from '@/services/blocks';
import type { PhaseNode, Placement } from '@/services/workflows';

const phases: PhaseNode[] = [
  {
    phaseId: 'construction',
    name: 'Construction',
    kind: 'phase',
    path: '01',
    parentPath: null,
    order: 1,
  },
];

const placements: Placement[] = [
  {
    stageId: 'code-generation',
    stageTenant: 'SYSTEM',
    pinnedVersion: null,
    phasePath: '01',
    order: 0,
    scopeMembership: { feature: 'EXECUTE' },
  },
];

const stagesById = {
  'code-generation': {
    id: 'code-generation',
    blockId: 'code-generation',
    name: 'Code Generation',
    phase: 'construction',
    forEach: 'unit-of-work',
    execution: 'CONDITIONAL',
  },
} as unknown as Record<string, Block>;

describe('PhaseLanes', () => {
  const handlers = {
    onDropStage: vi.fn(),
    onReorderPlacement: vi.fn(),
    onRemovePlacement: vi.fn(),
    onAddPhase: vi.fn(),
    onStartPhaseRename: vi.fn(),
    onCancelPhaseRename: vi.fn(),
    onRenamePhase: vi.fn(),
    onRemovePhase: vi.fn(),
    onApplySkeleton: vi.fn(),
    onOpenStage: vi.fn(),
  };

  it('renders branch badges and section warnings on stage chips', () => {
    render(
      <PhaseLanes
        phases={phases}
        placements={placements}
        stagesById={stagesById}
        readOnly
        compiled={null}
        branchIssues={{ 'code-generation': ['parallel section has no in-scope producer'] }}
        onDropStage={handlers.onDropStage}
        onReorderPlacement={handlers.onReorderPlacement}
        onRemovePlacement={handlers.onRemovePlacement}
        onAddPhase={handlers.onAddPhase}
        editingPhasePath={null}
        onStartPhaseRename={handlers.onStartPhaseRename}
        onCancelPhaseRename={handlers.onCancelPhaseRename}
        onRenamePhase={handlers.onRenamePhase}
        onRemovePhase={handlers.onRemovePhase}
        onApplySkeleton={handlers.onApplySkeleton}
        onOpenStage={handlers.onOpenStage}
      />,
    );

    expect(screen.getByText(/unit branch/i)).toBeInTheDocument();
    expect(screen.getByText(/parallel section has no in-scope producer/i)).toBeInTheDocument();
  });

  it('keeps legacy no-initialization skeletons aligned with seeded placement paths', () => {
    const legacyPhases: PhaseNode[] = [
      {
        phaseId: 'ideation',
        name: 'Ideation',
        kind: 'phase',
        path: '01',
        parentPath: null,
        order: 1,
      },
      {
        phaseId: 'inception',
        name: 'Inception',
        kind: 'phase',
        path: '02',
        parentPath: null,
        order: 2,
      },
      {
        phaseId: 'construction',
        name: 'Construction',
        kind: 'phase',
        path: '03',
        parentPath: null,
        order: 3,
      },
      {
        phaseId: 'operation',
        name: 'Operation',
        kind: 'phase',
        path: '04',
        parentPath: null,
        order: 4,
      },
    ];
    const shiftedPlacements: Placement[] = [
      {
        stageId: 'intent-capture',
        stageTenant: 'SYSTEM',
        pinnedVersion: null,
        phasePath: '02',
        order: 0,
        scopeMembership: { feature: 'EXECUTE' },
      },
    ];
    const shiftedStages = {
      'intent-capture': {
        id: 'intent-capture',
        blockId: 'intent-capture',
        name: 'Intent Capture',
        phase: 'ideation',
      },
    } as unknown as Record<string, Block>;

    const { container } = render(
      <PhaseLanes
        phases={legacyPhases}
        placements={shiftedPlacements}
        stagesById={shiftedStages}
        readOnly
        compiled={null}
        editingPhasePath={null}
        {...handlers}
      />,
    );

    const ideationLane = container.querySelector('[data-phase-id="ideation"]');
    const inceptionLane = container.querySelector('[data-phase-id="inception"]');
    expect(ideationLane).not.toBeNull();
    expect(inceptionLane).not.toBeNull();
    expect(within(ideationLane as HTMLElement).getByText('Intent Capture')).toBeInTheDocument();
    expect(
      within(inceptionLane as HTMLElement).queryByText('Intent Capture'),
    ).not.toBeInTheDocument();
  });
});
