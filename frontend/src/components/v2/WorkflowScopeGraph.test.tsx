import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
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
});
