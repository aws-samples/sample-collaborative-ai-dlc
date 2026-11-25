import { describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';

const { mockUseIntent } = vi.hoisted(() => ({
  mockUseIntent: vi.fn(),
}));

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: mockUseIntent,
}));

import { IntentPhaseBreadcrumb, detectSection } from './IntentPipelineBar';

const row = (
  stageId: string,
  state: string,
  over: Record<string, unknown> = {},
): Record<string, unknown> => ({
  stageId,
  state,
  stageInstanceId: `${stageId}-1`,
  unitSlug: null,
  runtimeError: null,
  planned: true,
  ...over,
});

const stageRows = [
  row('requirements', 'SUCCEEDED', { stageInstanceId: 'r1' }),
  row('build', 'SUCCEEDED', { stageInstanceId: 'b1', unitSlug: 'one' }),
  row('build', 'RUNNING', { stageInstanceId: 'b2', unitSlug: 'two' }),
];

const readyContext = {
  detail: {
    intent: {
      status: 'RUNNING',
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
    events: [],
  },
  stageRows,
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
    // The scope badge lives in the page header only (revert 1).
    expect(screen.queryByLabelText('Scope: Feature')).toBeNull();
    expect(screen.getByText('1 of 1 stage done')).toBeInTheDocument();
    expect(screen.getByText('0 of 1 stage done')).toBeInTheDocument();
    expect(screen.getByText('0 of 1 stage done')).toHaveAttribute(
      'title',
      '0 of 1 stages in scope are done',
    );
    expect(screen.queryByText(/selected stages/)).not.toBeInTheDocument();
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
    expect(placeholder).toHaveClass('h-12');
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
        intent: { ...readyContext.detail.intent, status: 'FAILED' },
        stages: [{ stageInstanceId: 'r1', stageId: 'requirements', state: 'FAILED' }],
      },
      stageRows: [row('requirements', 'FAILED', { stageInstanceId: 'r1' })],
      currentPhasePath: '01',
    });

    render(<IntentPhaseBreadcrumb />);

    const inception = screen.getByRole('button', { name: /Inception/ });
    expect(inception).toHaveClass('text-agent-error-fg');
    expect(inception).toHaveAttribute('data-state', 'failed');
    // The second line names where the run stopped instead of a 0/1 counter.
    expect(inception).toHaveTextContent('Failed at Requirements');
    await user.click(inception);

    expect(screen.getByText(/1 failed/)).toBeInTheDocument();
    expect(screen.getByText('failed')).toHaveClass('text-agent-error-fg');
  });

  // I8 (staging): the run failed before the stage got a row — the only FAILED
  // row has no stageId and is dropped, every planned row still reads PENDING.
  // The stage list infers the failed stage from the failure event; the bar
  // must paint the same phase red (T3 acceptance).
  it('paints the phase of an inferred failed stage red, like the stage list', () => {
    mockUseIntent.mockReturnValue({
      ...readyContext,
      detail: {
        ...readyContext.detail,
        intent: {
          ...readyContext.detail.intent,
          status: 'FAILED',
          failure: { code: 'not_implemented', message: 'mode pipeline' },
          failureReason: 'stage_failed: requirements: not_implemented: mode pipeline',
        },
        stages: [],
        events: [
          {
            type: 'v2.execution.failed',
            summary: 'stage_failed: requirements: not_implemented: mode pipeline',
          },
        ],
      },
      stageRows: [
        row('requirements', 'PENDING', { stageInstanceId: null }),
        row('build', 'PENDING', { stageInstanceId: null }),
      ],
      currentPhasePath: null,
    });

    render(<IntentPhaseBreadcrumb />);

    const inception = screen.getByRole('button', { name: /Inception/ });
    expect(inception).toHaveAttribute('data-state', 'failed');
    expect(inception).toHaveClass('text-agent-error-fg');
    expect(inception).toHaveTextContent('Failed at Requirements');
    expect(screen.getByRole('button', { name: /Construction/ })).toHaveAttribute(
      'data-state',
      'pending',
    );
  });

  // P1-2 (a11y audit): the pill text used the raw accent hue and an 80 %
  // opacity sub-line, reading at 2.1–3.7:1. Every state now paints its text
  // with the matching *-fg token (>= 4.5:1 on its own tint, both themes) and
  // the sub-line is fully opaque.
  it('paints every pill state with a text-safe foreground token and no faded sub-line', () => {
    mockUseIntent.mockReturnValue({
      ...readyContext,
      detail: {
        ...readyContext.detail,
        intent: {
          ...readyContext.detail.intent,
          composedGrid: { requirements: 'EXECUTE', build: 'EXECUTE', release: 'EXECUTE' },
        },
        stages: [
          { stageInstanceId: 'r1', stageId: 'requirements', state: 'SUCCEEDED' },
          { stageInstanceId: 'b1', stageId: 'build', state: 'RUNNING' },
        ],
      },
      stageRows: [
        row('requirements', 'SUCCEEDED', { stageInstanceId: 'r1' }),
        row('build', 'RUNNING', { stageInstanceId: 'b1' }),
        row('release', 'PENDING', { stageInstanceId: null }),
      ],
      compiled: {
        ...readyContext.compiled,
        graph: {
          nodes: [
            { stageId: 'requirements', phasePath: '01', order: 1 },
            { stageId: 'build', phasePath: '02', order: 2 },
            { stageId: 'release', phasePath: '03', order: 3 },
          ],
        },
      },
    });

    render(<IntentPhaseBreadcrumb />);

    const done = screen.getByRole('button', { name: /Inception/ });
    const running = screen.getByRole('button', { name: /Construction/ });
    const pending = screen.getByRole('button', { name: /Operation/ });
    expect(done).toHaveAttribute('data-state', 'done');
    expect(done).toHaveClass('text-agent-success-fg');
    expect(done).not.toHaveClass('text-agent-success');
    expect(running).toHaveAttribute('data-state', 'active');
    expect(running).toHaveClass('text-agent-running-fg');
    expect(running).not.toHaveClass('text-agent-running');
    expect(pending).toHaveAttribute('data-state', 'pending');
    expect(pending).toHaveClass('text-muted-foreground');

    for (const pill of [done, running, pending]) {
      for (const line of pill.querySelectorAll('span')) {
        expect(line.className).not.toMatch(/\bopacity-\d/);
      }
    }
  });

  // N8 (design review r2a): a run cancelled 127 days ago painted its last
  // phase purple ("Construction 5/7 · running"). A finished run has nothing
  // in progress: the unfinished phase reads neutral and says it stopped.
  it('paints the unfinished phase of a cancelled run neutral and stopped, not running', () => {
    mockUseIntent.mockReturnValue({
      ...readyContext,
      detail: {
        ...readyContext.detail,
        intent: {
          ...readyContext.detail.intent,
          status: 'CANCELLED',
          composedGrid: {
            requirements: 'EXECUTE',
            build: 'EXECUTE',
            test: 'EXECUTE',
            release: 'EXECUTE',
          },
        },
      },
      stageRows: [
        row('requirements', 'SUCCEEDED', { stageInstanceId: 'r1' }),
        row('build', 'SUCCEEDED', { stageInstanceId: 'b1' }),
        row('test', 'PENDING', { stageInstanceId: null }),
        row('release', 'PENDING', { stageInstanceId: null }),
      ],
      compiled: {
        ...readyContext.compiled,
        graph: {
          nodes: [
            { stageId: 'requirements', phasePath: '01', order: 1 },
            { stageId: 'build', phasePath: '02', order: 2 },
            { stageId: 'test', phasePath: '02', order: 3 },
            { stageId: 'release', phasePath: '03', order: 4 },
          ],
        },
      },
    });

    render(<IntentPhaseBreadcrumb />);

    const construction = screen.getByRole('button', { name: /Construction/ });
    expect(construction).toHaveAttribute('data-state', 'stopped');
    expect(construction).toHaveClass('bg-muted', 'text-muted-foreground');
    expect(construction).not.toHaveClass('text-agent-running-fg', 'bg-agent-running/10');
    expect(construction).toHaveTextContent('1 of 2 stages · stopped');
    // Still the phase a small screen scrolls to.
    expect(construction).toHaveAttribute('data-active', 'true');
    expect(screen.getByRole('button', { name: /Inception/ })).toHaveAttribute('data-state', 'done');
    const operation = screen.getByRole('button', { name: /Operation/ });
    expect(operation).toHaveAttribute('data-state', 'pending');
    expect(operation).toHaveTextContent('0 of 1 stage · not run');
    // The count never wraps mid-phrase ("0 of 7 stages / done"): one line,
    // the bar scrolls instead (R3-15).
    const count = within(construction).getByText('1 of 2 stages · stopped');
    expect(count).toHaveClass('whitespace-nowrap', 'truncate');
    expect(construction).toHaveClass('min-w-52');
  });

  it('keeps the failed tone on the failed phase of a finished run', () => {
    mockUseIntent.mockReturnValue({
      ...readyContext,
      detail: {
        ...readyContext.detail,
        intent: { ...readyContext.detail.intent, status: 'FAILED' },
        stages: [{ stageInstanceId: 'b1', stageId: 'build', state: 'FAILED' }],
      },
      stageRows: [
        row('requirements', 'SUCCEEDED', { stageInstanceId: 'r1' }),
        row('build', 'FAILED', { stageInstanceId: 'b1' }),
      ],
    });

    render(<IntentPhaseBreadcrumb />);

    const construction = screen.getByRole('button', { name: /Construction/ });
    expect(construction).toHaveAttribute('data-state', 'failed');
    expect(construction).toHaveClass('text-agent-error-fg');
    expect(construction).toHaveTextContent('Failed at Build');
  });

  it('says a phase a completed run never reached was not run', () => {
    mockUseIntent.mockReturnValue({
      ...readyContext,
      detail: {
        ...readyContext.detail,
        intent: { ...readyContext.detail.intent, status: 'SUCCEEDED' },
      },
      stageRows: [
        row('requirements', 'SUCCEEDED', { stageInstanceId: 'r1' }),
        row('build', 'PENDING', { stageInstanceId: null }),
      ],
    });

    render(<IntentPhaseBreadcrumb />);

    expect(screen.getByRole('button', { name: /Construction/ })).toHaveTextContent(
      '0 of 1 stage · not run',
    );
  });

  it('marks the phase to bring into view on small screens', () => {
    mockUseIntent.mockReturnValue(readyContext);
    render(<IntentPhaseBreadcrumb />);
    expect(screen.getByRole('button', { name: /Construction/ })).toHaveAttribute(
      'data-active',
      'true',
    );
    expect(screen.getByRole('button', { name: /Inception/ })).not.toHaveAttribute('data-active');
  });
});

describe('detectSection', () => {
  it('maps intent routes', () => {
    expect(detectSection('/space/p/intent/i')).toBe('work');
    expect(detectSection('/space/p/intent/i/observability')).toBe('overview');
    expect(detectSection('/space/p/intent/i/graph')).toBe('graph');
  });
});
