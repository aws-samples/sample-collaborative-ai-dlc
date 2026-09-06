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
      composedGrid: { requirements: 'EXECUTE', design: 'SKIP', build: 'EXECUTE' },
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
      ],
    },
  },
  phaseNameOf: (phase: string) => (phase === '01' ? 'Inception' : 'Construction'),
  initializationPhasePaths: new Set<string>(),
  workflowPhases: [{ path: '01' }, { path: '02' }],
  currentPhasePath: '02',
};

describe('IntentPhaseBreadcrumb', () => {
  it('uses selected stage definitions and collapses parallel instances', () => {
    mockUseIntent.mockReturnValue(readyContext);
    render(<IntentPhaseBreadcrumb />);
    expect(screen.getByLabelText('Scope: feature')).toBeInTheDocument();
    expect(screen.getByText('1/1 selected steps')).toBeInTheDocument();
    expect(screen.getByText('0/1 selected steps')).toBeInTheDocument();
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

  it('opens the run configuration from a phase with excluded steps', async () => {
    const user = userEvent.setup();
    const onOpenConfiguration = vi.fn();
    mockUseIntent.mockReturnValue(readyContext);

    render(<IntentPhaseBreadcrumb onOpenConfiguration={onOpenConfiguration} />);

    await user.click(screen.getByRole('button', { name: /Inception/ }));
    await user.click(screen.getByRole('button', { name: 'View configuration' }));

    expect(onOpenConfiguration).toHaveBeenCalledOnce();
  });
});

describe('detectSection', () => {
  it('maps intent routes', () => {
    expect(detectSection('/space/p/intent/i')).toBe('work');
    expect(detectSection('/space/p/intent/i/observability')).toBe('overview');
    expect(detectSection('/space/p/intent/i/graph')).toBe('graph');
  });
});
