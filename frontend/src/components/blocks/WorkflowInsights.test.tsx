import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { WorkflowInsights } from './WorkflowInsights';
import type { CompiledWorkflow } from '@/services/workflows';

const compiled = (unresolved: string[]): CompiledWorkflow => ({
  scopeGrid: {},
  autonomy: { perStage: {}, rollup: { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 } },
  graph: {
    nodes: [],
    edges: [],
    cycles: [],
    danglingConsumes: [],
    orphanProduces: [],
    unknownArtifacts: [],
    acyclic: true,
  },
  rules: { universal: [], phaseRules: {}, pairings: [], perStage: {}, unresolved },
});

describe('WorkflowInsights', () => {
  it('surfaces unresolved rule refs as validation warnings', () => {
    render(<WorkflowInsights compiled={compiled(['ghost-rule'])} />);
    expect(screen.getByText('ghost-rule')).toBeInTheDocument();
    expect(screen.getByText(/doesn't resolve to a rule block/)).toBeInTheDocument();
    expect(screen.queryByText(/No cycles, no orphan artifacts/)).not.toBeInTheDocument();
  });

  it('stays clean when every rule ref resolves', () => {
    render(<WorkflowInsights compiled={compiled([])} />);
    expect(screen.getByText(/No cycles, no orphan artifacts/)).toBeInTheDocument();
  });
});
