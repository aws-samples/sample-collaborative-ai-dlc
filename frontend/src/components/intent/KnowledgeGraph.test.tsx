import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

const openDiscussionById = vi.fn();
vi.mock('@/components/discussion/DiscussionProvider', () => ({
  useDiscussions: () => ({ openDiscussionById }),
}));
vi.mock('@/components/discussion/DiscussButton', () => ({
  DiscussButton: ({ entityType }: { entityType: string }) => (
    <button data-testid="discuss" data-entity={entityType} />
  ),
}));
vi.mock('@/hooks/useIntentEvents', () => ({ useIntentEvents: () => {} }));

const get = vi.fn();
const graph = vi.fn();
vi.mock('@/services/intents', () => ({
  intentsService: {
    get: (...a: unknown[]) => get(...a),
    graph: (...a: unknown[]) => graph(...a),
  },
}));
vi.mock('@/services/workflows', () => ({
  workflowsService: { compiled: vi.fn().mockResolvedValue({ graph: { nodes: [], edges: [] } }) },
}));

import { KnowledgeGraph, settleLayout } from './KnowledgeGraph';
import { IntentProvider } from '@/contexts/IntentContext';

const renderGraph = () =>
  render(
    <MemoryRouter initialEntries={['/project/p1/intent/i1']}>
      <Routes>
        <Route
          path="/project/:projectId/intent/:intentId"
          element={
            <IntentProvider>
              <KnowledgeGraph />
            </IntentProvider>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const detail = {
  intent: {
    id: 'i1',
    executionId: 'i1',
    projectId: 'p1',
    title: 'T',
    prompt: 'P',
    status: 'RUNNING',
    workflowId: 'wf',
    workflowVersion: 1,
    scope: 'feature',
    currentStage: null,
    pendingHumanTaskId: null,
    createdAt: null,
    updatedAt: null,
    completedAt: null,
  },
  stages: [{ stageInstanceId: 'si-a', stageId: 'stage-a', state: 'SUCCEEDED', phase: 'p' }],
  events: [],
  gates: [{ humanTaskId: 'q-1', status: 'answered', kind: 'question', questions: '[]' }],
  metrics: [],
  outputs: [],
  sensorRuns: [],
  artifacts: [],
};

const knowledgeGraph = {
  nodes: [
    { id: 'i1', type: 'Intent', label: 'Build login' },
    {
      id: 'a1',
      type: 'Artifact',
      label: 'Reqs',
      artifactType: 'requirements-analysis',
      createdByStageInstanceId: 'si-a',
      contentPreview: '# hi',
      contentLength: 4,
      createdAt: '2026-01-01T00:00:00Z',
    },
    {
      id: 'q-1',
      type: 'Question',
      label: 'Which auth provider?',
      questions: JSON.stringify([{ text: 'Which auth provider?', type: 'single', options: [] }]),
    },
    { id: 'tk-1', type: 'TeamKnowledge', label: 'Naming convention', agentRef: 'shared' },
    { id: 'disc-1', type: 'Discussion', label: 'Reqs thread', status: 'open' },
  ],
  edges: [
    { source: 'i1', target: 'a1', label: 'CONTAINS' },
    { source: 'i1', target: 'q-1', label: 'CONTAINS' },
    { source: 'tk-1', target: 'i1', label: 'INFORMS' },
    { source: 'disc-1', target: 'a1', label: 'DISCUSSES' },
  ],
};

describe('settleLayout', () => {
  const nodes = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  const edges = [
    { source: 'a', target: 'b' },
    { source: 'b', target: 'c' },
  ];

  it('is deterministic — identical inputs settle to identical positions', () => {
    const one = settleLayout(nodes, edges);
    const two = settleLayout(nodes, edges);
    expect([...one.entries()]).toEqual([...two.entries()]);
    for (const p of one.values()) {
      expect(Number.isFinite(p.x)).toBe(true);
      expect(Number.isFinite(p.y)).toBe(true);
    }
  });

  it('pulls linked nodes closer than unlinked ones', () => {
    const pos = settleLayout(nodes, edges);
    const d = (m: string, n: string) => {
      const a = pos.get(m)!;
      const b = pos.get(n)!;
      return Math.hypot(a.x - b.x, a.y - b.y);
    };
    // a—b are linked; a…c only transitively — the chain must not collapse.
    expect(d('a', 'b')).toBeLessThan(d('a', 'c'));
  });
});

describe('KnowledgeGraph', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue(detail);
    graph.mockReset().mockResolvedValue(knowledgeGraph);
    openDiscussionById.mockReset();
  });

  it('renders typed nodes and a legend with counts', async () => {
    renderGraph();
    // Node chips carry their label as `title` (truncation tooltip).
    expect(await screen.findByTitle('Reqs')).toBeVisible();
    expect(screen.getByRole('button', { name: /Which auth provider/ })).toBeVisible();
    expect(screen.getByRole('button', { name: /Naming convention/ })).toBeVisible();
    // Legend row for the knowledge corpus (also appears as the node subline).
    expect(screen.getAllByText('Team knowledge').length).toBeGreaterThan(0);
  });

  it('artifact detail shows provenance and jumps to the artifact card', async () => {
    renderGraph();
    await userEvent.click(await screen.findByTitle('Reqs'));
    expect(screen.getByText(/produced by stage-a/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Open artifact card/ })).toBeInTheDocument();
    // Per-artifact discussion entry point rides along.
    expect(screen.getByTestId('discuss')).toHaveAttribute('data-entity', 'artifact');
  });

  it('question detail joins the gate list for its answered state', async () => {
    renderGraph();
    await userEvent.click(await screen.findByRole('button', { name: /Which auth provider/ }));
    expect(screen.getByText('answered')).toBeInTheDocument();
  });

  it('discussion detail opens the thread in the sidebar', async () => {
    renderGraph();
    await userEvent.click(await screen.findByRole('button', { name: /Reqs thread/ }));
    await userEvent.click(screen.getByRole('button', { name: /Open thread/ }));
    expect(openDiscussionById).toHaveBeenCalledWith('disc-1');
  });

  it('shows the empty state before the run produced anything', async () => {
    graph.mockResolvedValue({ nodes: [], edges: [] });
    renderGraph();
    expect(await screen.findByText(/Nothing recorded yet/)).toBeInTheDocument();
  });
});
