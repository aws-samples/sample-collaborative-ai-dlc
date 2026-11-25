import { describe, it, expect, vi } from 'vitest';
import { render, fireEvent } from '@/test/query';
import { WorkflowScopeGraph } from './WorkflowScopeGraph';
import type { CompiledWorkflow } from '@/services/workflows';
import type { StageState } from '@/services/intents';

const compiled: CompiledWorkflow = {
  graph: {
    nodes: [
      { stageId: 's1', phasePath: '01', order: 0 },
      { stageId: 's2', phasePath: '02', order: 1 },
      { stageId: 's3', phasePath: '03', order: 2 },
    ],
    edges: [
      { from: 's1', to: 's2', kind: 'requires' },
      { from: 's2', to: 's3', kind: 'data', artifact: 'spec' },
    ],
  },
  scopeGrid: {
    feature: { s1: 'EXECUTE', s2: 'EXECUTE', s3: 'SKIP' },
    lite: { s1: 'EXECUTE', s2: 'SKIP', s3: 'SKIP' },
  },
} as unknown as CompiledWorkflow;

describe('WorkflowScopeGraph', () => {
  it('renders default scope-based coloring when stageStatus is undefined', () => {
    const { container } = render(
      <WorkflowScopeGraph compiled={compiled} scopes={['feature', 'lite']} readOnly />,
    );
    const svg = container.querySelector('svg')!;
    expect(svg).toBeInTheDocument();
    const groups = svg.querySelectorAll('g[data-stage-status]');
    expect(groups).toHaveLength(0);
  });

  it('applies SUCCEEDED status to nodes present in stageStatus', () => {
    const stageStatus: Record<string, StageState> = { s1: 'SUCCEEDED' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const node = container.querySelector('g[data-stage-status="SUCCEEDED"]');
    expect(node).toBeInTheDocument();
    const rect = node!.querySelector('rect');
    expect(rect).toHaveAttribute('fill', 'var(--agent-success)');
  });

  it('applies RUNNING status with pulse class', () => {
    const stageStatus: Record<string, StageState> = { s2: 'RUNNING' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const node = container.querySelector('g[data-stage-status="RUNNING"]');
    expect(node).toBeInTheDocument();
    expect(node).toHaveClass('animate-pulse-subtle');
    const rect = node!.querySelector('rect');
    expect(rect).toHaveAttribute('fill', 'var(--agent-running)');
  });

  it('applies FAILED status color', () => {
    const stageStatus: Record<string, StageState> = { s3: 'FAILED' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const node = container.querySelector('g[data-stage-status="FAILED"]');
    expect(node).toBeInTheDocument();
    const rect = node!.querySelector('rect');
    expect(rect).toHaveAttribute('fill', 'var(--agent-error)');
  });

  it('nodes without stageStatus entry fall back to scope-based rendering', () => {
    const stageStatus: Record<string, StageState> = { s1: 'SUCCEEDED' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const allStatusNodes = container.querySelectorAll('g[data-stage-status]');
    expect(allStatusNodes).toHaveLength(1);
  });

  it('hides EXEC/SKIP pill when stageStatus is provided', () => {
    const stageStatus: Record<string, StageState> = { s1: 'SUCCEEDED', s2: 'RUNNING' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const pills = container.querySelectorAll('text');
    const execSkipTexts = Array.from(pills).filter(
      (t) => t.textContent === 'EXEC' || t.textContent === 'SKIP',
    );
    expect(execSkipTexts).toHaveLength(0);
  });

  it('shows EXEC/SKIP pill when stageStatus is not provided', () => {
    const { container } = render(
      <WorkflowScopeGraph compiled={compiled} scopes={['feature', 'lite']} readOnly />,
    );
    const pills = container.querySelectorAll('text');
    const execSkipTexts = Array.from(pills).filter(
      (t) => t.textContent === 'EXEC' || t.textContent === 'SKIP',
    );
    expect(execSkipTexts.length).toBeGreaterThan(0);
  });

  it('renders branch markers from compiled graph metadata', () => {
    const branched = {
      ...compiled,
      graph: {
        ...compiled.graph,
        nodes: [
          { ...compiled.graph.nodes[0], forEach: 'unit-of-work', section: 1 },
          ...compiled.graph.nodes.slice(1),
        ],
      },
    } as CompiledWorkflow;
    const { container } = render(
      <WorkflowScopeGraph compiled={branched} scopes={['feature']} readOnly />,
    );
    const labels = Array.from(container.querySelectorAll('text')).map((node) => node.textContent);
    expect(labels).toContain('Round 1');
  });

  // N15 (design review r2a): "BR 2/4/1" badges had no legend, and every
  // dependency edge was drawn at once — unreadable spaghetti.
  it('spells a repeated stage as "Round n" (no "BR" code), in a tooltip and in the legend (R3-9)', () => {
    const branched = {
      ...compiled,
      graph: {
        ...compiled.graph,
        nodes: [
          { ...compiled.graph.nodes[0], forEach: 'unit-of-work', section: 2 },
          ...compiled.graph.nodes.slice(1),
        ],
      },
    } as CompiledWorkflow;
    const { container, getByRole, getByLabelText } = render(
      <WorkflowScopeGraph compiled={branched} scopes={['feature']} readOnly />,
    );
    const badge = getByRole('img', { name: 'Round 2 — runs once per unit of work' });
    expect(badge.querySelector('title')).toHaveTextContent('Round 2 — runs once per unit of work');
    expect(getByLabelText('Legend')).toHaveTextContent('Round n — runs once per unit of work');
    expect(getByLabelText('Legend')).not.toHaveTextContent(/\bBR\b/);
    expect(container.querySelectorAll('text')).not.toHaveLength(0);
  });

  it('leaves the legend without a bolt-round entry when no stage repeats per unit', () => {
    const { getByLabelText } = render(
      <WorkflowScopeGraph compiled={compiled} scopes={['feature']} readOnly />,
    );
    expect(getByLabelText('Legend')).not.toHaveTextContent('Round n');
  });

  // The workflow composer's Validate view: every edge, always, no hover state.
  it('draws every dependency edge by default, without the hover hint', () => {
    const { container, queryByTestId } = render(
      <WorkflowScopeGraph compiled={compiled} scopes={['feature']} readOnly />,
    );
    expect(
      Array.from(container.querySelectorAll('path[data-edge]')).map((p) =>
        p.getAttribute('data-edge'),
      ),
    ).toEqual(['s1->s2', 's2->s3']);
    expect(queryByTestId('scope-graph-edge-hint')).toBeNull();
    const node = container.querySelector('g[transform]:not([role])');
    if (node) fireEvent.mouseEnter(node);
    expect(container.querySelectorAll('path[data-edge]')).toHaveLength(2);
  });

  it('with edgesOnFocus, draws dependency edges only for the hovered or selected stage', () => {
    const handler = vi.fn();
    const { container, getByTestId } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        readOnly
        edgesOnFocus
        onStageClick={handler}
        stageMeta={{
          s1: { number: '1', name: 'Intent Capture', phase: '01' },
          s2: { number: '2', name: 'Scope Definition', phase: '02' },
          s3: { number: '3', name: 'Build', phase: '03' },
        }}
      />,
    );
    const edges = () =>
      Array.from(container.querySelectorAll('path[data-edge]')).map((p) =>
        p.getAttribute('data-edge'),
      );
    expect(edges()).toEqual([]);
    expect(getByTestId('scope-graph-edge-hint')).toHaveTextContent(
      'Hover or select a stage to see its dependencies.',
    );

    const [s1, s2] = Array.from(container.querySelectorAll('g[role="button"]'));
    fireEvent.mouseEnter(s2);
    expect(edges()).toEqual(['s1->s2', 's2->s3']);
    expect(getByTestId('scope-graph-edge-hint')).toHaveTextContent(
      'Showing the dependencies of Scope Definition',
    );
    expect(s2.querySelector('rect')).toHaveAttribute('stroke', 'var(--ring)');
    fireEvent.mouseLeave(s2);
    expect(edges()).toEqual([]);

    // A click pins the stage (and still reaches the host) until clicked again.
    fireEvent.click(s1);
    expect(handler).toHaveBeenCalledWith('s1');
    expect(edges()).toEqual(['s1->s2']);
    expect(getByTestId('scope-graph-edge-hint')).toHaveTextContent(
      'Showing the dependency of Intent Capture · select it again to clear',
    );
    fireEvent.mouseEnter(s2);
    expect(edges()).toEqual(['s1->s2', 's2->s3']);
    fireEvent.mouseLeave(s2);
    expect(edges()).toEqual(['s1->s2']);
    fireEvent.click(s1);
    expect(edges()).toEqual([]);

    // Keyboard focus works like hover.
    fireEvent.focus(s2);
    expect(edges()).toEqual(['s1->s2', 's2->s3']);
    fireEvent.blur(s2);
    expect(edges()).toEqual([]);
  });

  it('SKIPPED status renders dashed stroke and reduced opacity', () => {
    const stageStatus: Record<string, StageState> = { s2: 'SKIPPED' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const node = container.querySelector('g[data-stage-status="SKIPPED"]');
    expect(node).toBeInTheDocument();
    expect(node).toHaveAttribute('opacity', '0.55');
    const rect = node!.querySelector('rect');
    expect(rect).toHaveAttribute('stroke', 'var(--muted-foreground)');
    expect(rect).toHaveAttribute('stroke-dasharray', '4 3');
  });

  it('fires onStageClick when a node is clicked', () => {
    const stageStatus: Record<string, StageState> = { s1: 'SUCCEEDED', s2: 'RUNNING' };
    const handler = vi.fn();
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
        onStageClick={handler}
      />,
    );
    const node = container.querySelector('g[data-stage-status="SUCCEEDED"]');
    expect(node).toBeInTheDocument();
    expect(node).toHaveAttribute('role', 'button');
    fireEvent.click(node!);
    expect(handler).toHaveBeenCalledWith('s1');
  });

  it('renders its legend and summary by default, and hides them on request', () => {
    const { container, rerender } = render(
      <WorkflowScopeGraph compiled={compiled} scopes={['feature']} readOnly />,
    );
    expect(container.querySelector('[aria-label="Legend"]')).toBeInTheDocument();
    expect(container.textContent).toContain('2 of 3 stages run');

    rerender(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        readOnly
        hideLegend
        hideSummary
      />,
    );
    expect(container.querySelector('[aria-label="Legend"]')).not.toBeInTheDocument();
    expect(container.textContent).not.toContain('stages run');
  });

  it('keeps every text at or above the 11 px floor', () => {
    const { container } = render(
      <WorkflowScopeGraph compiled={compiled} scopes={['feature', 'lite']} readOnly />,
    );
    const tiny = [...container.querySelectorAll('[class*="text-["]')].filter((el) => {
      const match = /text-\[(\d+(?:\.\d+)?)px\]/.exec(el.getAttribute('class') ?? '');
      return match && Number(match[1]) < 11;
    });
    expect(tiny).toHaveLength(0);
    expect(container.querySelector('[class*="text-[10px]"]')).toBeNull();
    expect(container.querySelector('[class*="text-[8px]"]')).toBeNull();
  });

  it('does not add interactive attributes when onStageClick is absent', () => {
    const stageStatus: Record<string, StageState> = { s1: 'SUCCEEDED' };
    const { container } = render(
      <WorkflowScopeGraph
        compiled={compiled}
        scopes={['feature']}
        stageStatus={stageStatus}
        readOnly
      />,
    );
    const node = container.querySelector('g[data-stage-status="SUCCEEDED"]');
    expect(node).toBeInTheDocument();
    expect(node).not.toHaveAttribute('role');
  });
});
