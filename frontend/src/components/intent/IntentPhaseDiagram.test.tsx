import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { IntentStageDependencies, StageDependenciesSheet } from './IntentPhaseDiagram';

type Globals = {
  depRows?: unknown[];
  depCompiled?: unknown;
  depDetail?: unknown;
  depPhases?: unknown[] | null;
  setSelectedStageId?: (key: string | null) => void;
};
const g = globalThis as Globals;

vi.mock('@/contexts/IntentContext', () => ({
  stageRowKey: (row: { stageId: string; stageInstanceId: string | null }) =>
    row.stageInstanceId ?? row.stageId,
  useIntent: () => ({
    intentId: 'intent-1',
    stageRows: g.depRows ?? [],
    compiled: g.depCompiled ?? null,
    detail: g.depDetail ?? null,
    workflowPhases: g.depPhases ?? null,
    initializationPhasePaths: new Set(
      ((g.depPhases ?? []) as { phaseId: string; path: string }[])
        .filter((p) => p.phaseId === 'initialization')
        .map((p) => p.path),
    ),
    phaseNameOf: (path: string) =>
      ((g.depPhases ?? []) as { path: string; name: string }[]).find((p) => p.path === path)
        ?.name ?? path,
    setSelectedStageId: g.setSelectedStageId ?? vi.fn(),
  }),
}));

beforeEach(() => {
  g.depPhases = null;
  g.setSelectedStageId = undefined;
  g.depRows = [
    { stageId: 'reverse-engineering', state: 'SUCCEEDED', planned: true },
    { stageId: 'requirements-analysis', state: 'WAITING_FOR_HUMAN', planned: true },
    { stageId: 'code-generation', state: 'PENDING', planned: true },
  ];
  g.depDetail = { intent: { scope: 'bugfix' } };
  g.depCompiled = {
    scopeGrid: {
      bugfix: {
        'reverse-engineering': 'EXECUTE',
        'requirements-analysis': 'EXECUTE',
        'code-generation': 'EXECUTE',
        'user-stories': 'SKIP',
      },
    },
    graph: {
      nodes: [
        'reverse-engineering',
        'requirements-analysis',
        'code-generation',
        'user-stories',
      ].map((stageId, order) => ({ stageId, phasePath: '02', order })),
      edges: [],
    },
  };
});

// O6: the dependency view opens in a full-width sheet with a truthful summary
// and a legend limited to the states actually present.
describe('StageDependenciesSheet', () => {
  it('opens a sheet with an in-scope summary, a present-states legend and the graph', async () => {
    render(
      <StageDependenciesSheet>
        <svg data-testid="graph" />
      </StageDependenciesSheet>,
    );

    expect(screen.queryByTestId('graph')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'View stage dependencies' }));

    const sheet = await screen.findByRole('dialog', { name: 'Stage dependencies' });
    expect(sheet).toHaveTextContent('1 of 3 stages completed · 1 stage not selected');
    expect(within(sheet).getByTestId('graph')).toBeInTheDocument();

    const legend = within(sheet).getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('Completed')).toBeInTheDocument();
    expect(within(legend).getByText('Waiting for input')).toBeInTheDocument();
    expect(within(legend).getByText('Not started')).toBeInTheDocument();
    expect(within(legend).queryByText('Failed')).not.toBeInTheDocument();
    expect(within(legend).queryByText('Running')).not.toBeInTheDocument();
  });

  it('is controllable and accepts a custom trigger label', async () => {
    const onOpenChange = vi.fn();
    render(
      <StageDependenciesSheet open={false} onOpenChange={onOpenChange} triggerLabel="Dependencies">
        <svg data-testid="graph" />
      </StageDependenciesSheet>,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Dependencies' }));
    expect(onOpenChange).toHaveBeenCalledWith(true);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

// O6 follow-up: the Overview's self-contained dependency view — display names on
// nodes, in-plan counts matching the usage card, selection handed to the list.
describe('IntentStageDependencies', () => {
  it('renders the scoped graph with human names and hands a node click to the list', async () => {
    const setSelectedStageId = vi.fn();
    g.setSelectedStageId = setSelectedStageId;
    g.depRows = [
      {
        stageId: 'reverse-engineering',
        stageInstanceId: 'si-re',
        state: 'SUCCEEDED',
        planned: true,
        phase: '02',
      },
      {
        stageId: 'requirements-analysis',
        stageInstanceId: 'si-ra',
        state: 'WAITING_FOR_HUMAN',
        planned: true,
        phase: '02',
      },
      {
        stageId: 'code-generation',
        stageInstanceId: null,
        state: 'PENDING',
        planned: true,
        phase: '02',
      },
      { stageId: 'state-init', stageInstanceId: 'si-init', state: 'SUCCEEDED', planned: false },
    ];
    g.depPhases = [
      { phaseId: 'initialization', path: '01', name: 'Initialization' },
      { phaseId: 'inception', path: '02', name: 'Inception' },
    ];

    render(<IntentStageDependencies />);

    await userEvent.click(screen.getByRole('button', { name: 'View stage dependencies' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stage dependencies' });
    expect(sheet).toHaveTextContent('1 of 3 stages completed');

    const node = await within(sheet).findByRole('button', { name: 'Reverse Engineering' });
    expect(sheet).not.toHaveTextContent('reverse-engineering');
    expect(within(sheet).queryByRole('button', { name: /state.init/i })).not.toBeInTheDocument();

    await userEvent.click(node);
    expect(setSelectedStageId).toHaveBeenCalledWith('si-re');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('says there is no graph data yet when the workflow has not compiled', async () => {
    g.depCompiled = null;
    render(<IntentStageDependencies />);

    await userEvent.click(screen.getByRole('button', { name: 'View stage dependencies' }));
    const sheet = await screen.findByRole('dialog', { name: 'Stage dependencies' });
    expect(within(sheet).getByText('No graph data yet.')).toBeInTheDocument();
    expect(within(sheet).queryByRole('button', { name: 'Reverse Engineering' })).toBeNull();
  });
});
