import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TooltipProvider } from '@/components/ui/tooltip';

vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ projectId: 'p-1', intentId: 'i-1', loading: false, error: null }),
}));

const graphMock = vi.fn();
vi.mock('@/hooks/useIntentGraph', () => ({
  useIntentGraph: (...args: unknown[]) => graphMock(...args),
}));

vi.mock('@/components/graph/GraphCanvas', () => ({
  GraphCanvas: ({
    nodes,
    headerLeading,
  }: {
    nodes: { id: string }[];
    headerLeading: React.ReactNode;
  }) => (
    <div data-testid="graph-canvas" data-node-count={nodes.length}>
      {headerLeading}
    </div>
  ),
}));

import IntentGraphPage from './IntentGraphPage';

const NODES = [
  { id: 'intent-1', type: 'Intent', label: 'Intent' },
  { id: 'art-1', type: 'Artifact', label: 'Stories' },
  { id: 'story-1', type: 'Story', label: 'Login', graphLayer: 'derived' },
  { id: 'unit-1', type: 'UnitOfWork', label: 'u-build', graphLayer: 'derived' },
];

const EDGES = [
  { source: 'intent-1', target: 'art-1', label: 'CONTAINS' },
  { source: 'art-1', target: 'story-1', label: 'HAS_ITEM' },
  { source: 'story-1', target: 'unit-1', label: 'DERIVED_FROM' },
];

beforeEach(() => {
  graphMock.mockReturnValue({ nodes: NODES, edges: EDGES, loading: false, error: null });
});

function renderPage() {
  return render(
    <TooltipProvider>
      <IntentGraphPage />
    </TooltipProvider>,
  );
}

describe('IntentGraphPage layer switching', () => {
  it('defaults to artifacts layer (hides derived nodes)', () => {
    renderPage();
    const canvas = screen.getByTestId('graph-canvas');
    expect(canvas).toHaveAttribute('data-node-count', '2');
  });

  it('switches to all layer when "+ Items & Units" is pressed', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /items and units/i }));
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('data-node-count', '4');
  });

  it('switches back to artifacts layer', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /items and units/i }));
    await user.click(screen.getByRole('button', { name: /artifacts layer/i }));
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('data-node-count', '2');
  });

  it('marks the active button with aria-pressed', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /artifacts layer/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /items and units/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('exposes a group role with accessible label', () => {
    renderPage();
    expect(screen.getByRole('group', { name: /graph layer/i })).toBeInTheDocument();
  });
});
