import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const { mockUseIntent } = vi.hoisted(() => ({
  mockUseIntent: vi.fn(),
}));

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: mockUseIntent,
}));

import { IntentPhaseBreadcrumb, detectSection } from './IntentPipelineBar';

const readyContext = {
  detail: {
    intent: {
      scope: 'feature',
      composedGrid: {
        requirements: 'EXECUTE',
        design: 'SKIP',
        build: 'EXECUTE',
        release: 'SKIP',
      },
      skipStageIds: [],
    },
    stages: [
      { stageInstanceId: 'r1', stageId: 'requirements', state: 'SUCCEEDED' },
      { stageInstanceId: 'b1', stageId: 'build', state: 'SUCCEEDED', unitSlug: 'one' },
      { stageInstanceId: 'b2', stageId: 'build', state: 'RUNNING', unitSlug: 'two' },
    ],
  },
  compiled: {
    scopeGrid: {},
    graph: {
      nodes: [
        { stageId: 'requirements', phasePath: '01', order: 1 },
        { stageId: 'design', phasePath: '01', order: 2 },
        { stageId: 'build', phasePath: '02', order: 3 },
        { stageId: 'release', phasePath: '03', order: 4 },
      ],
    },
  },
  phaseNameOf: (phase: string) =>
    phase === '01' ? 'Inception' : phase === '02' ? 'Construction' : 'Operation',
  initializationPhasePaths: new Set<string>(),
  workflowPhases: [{ path: '01' }, { path: '02' }, { path: '03' }],
  currentPhasePath: '02',
};

describe('IntentPhaseBreadcrumb', () => {
  it('uses selected stage definitions and collapses parallel instances', () => {
    mockUseIntent.mockReturnValue(readyContext);
    render(<IntentPhaseBreadcrumb />);
    expect(screen.getByLabelText('Scope: feature')).toBeInTheDocument();
    expect(screen.getByText('1/1 selected stages')).toBeInTheDocument();
    expect(screen.getByText('0/1 selected stages')).toBeInTheDocument();
    expect(screen.queryByText('Operation')).not.toBeInTheDocument();
    const scroller = screen.getByTestId('intent-phase-breadcrumb-scroll');
    expect(scroller).toHaveClass('flex', 'w-full', 'overflow-x-auto');
    expect(scroller).not.toHaveClass('min-w-max');
  });

  it('reserves the breadcrumb space while workflow metadata loads', () => {
    mockUseIntent.mockReturnValue({
      ...readyContext,
      compiled: null,
      workflowPhases: null,
    });

    render(<IntentPhaseBreadcrumb />);

    const placeholder = screen.getByTestId('intent-phase-breadcrumb-placeholder');
    expect(placeholder).toHaveClass('space-y-2');
    expect(placeholder.children).toHaveLength(2);
    expect(screen.queryByTestId('intent-phase-breadcrumb')).not.toBeInTheDocument();
  });

  it('opens the scope definition from a phase with excluded stages', async () => {
    const user = userEvent.setup();
    const onOpenScopeDefinition = vi.fn();
    mockUseIntent.mockReturnValue(readyContext);

    render(<IntentPhaseBreadcrumb onOpenScopeDefinition={onOpenScopeDefinition} />);

    await user.click(screen.getByRole('button', { name: /Inception/ }));
    await user.click(screen.getByRole('button', { name: 'Scope definition' }));

    expect(onOpenScopeDefinition).toHaveBeenCalledOnce();
  });

  it('renders failed stages as failures instead of running work', async () => {
    const user = userEvent.setup();
    mockUseIntent.mockReturnValue({
      ...readyContext,
      detail: {
        ...readyContext.detail,
        stages: [{ stageInstanceId: 'r1', stageId: 'requirements', state: 'FAILED' }],
      },
      currentPhasePath: '01',
    });

    render(<IntentPhaseBreadcrumb />);

    const inception = screen.getByRole('button', { name: /Inception/ });
    expect(inception).toHaveClass('text-destructive');
    await user.click(inception);

    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toHaveClass('text-destructive');
  });
});

describe('detectSection', () => {
  it('maps intent routes', () => {
    expect(detectSection('/space/p/intent/i')).toBe('work');
    expect(detectSection('/space/p/intent/i/observability')).toBe('overview');
    expect(detectSection('/space/p/intent/i/graph')).toBe('graph');
  });
});
