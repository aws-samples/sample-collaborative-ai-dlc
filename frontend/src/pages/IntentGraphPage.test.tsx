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
  {
    id: 'codefile-1',
    type: 'CodeFile',
    label: 'src/auth.ts',
    graphLayer: 'implementation',
  },
];

const EDGES = [
  { source: 'intent-1', target: 'art-1', label: 'CONTAINS' },
  { source: 'art-1', target: 'story-1', label: 'HAS_ITEM' },
  { source: 'story-1', target: 'unit-1', label: 'DERIVED_FROM' },
];

beforeEach(() => {
  graphMock.mockReturnValue({
    nodes: NODES,
    edges: EDGES,
    loading: false,
    error: null,
    hasCodeTraceability: true,
  });
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
    await user.click(screen.getByRole('button', { name: /items, units and code layer/i }));
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('data-node-count', '5');
  });

  it('switches back to artifacts layer', async () => {
    const user = userEvent.setup();
    renderPage();
    await user.click(screen.getByRole('button', { name: /items, units and code layer/i }));
    await user.click(screen.getByRole('button', { name: /artifacts layer/i }));
    expect(screen.getByTestId('graph-canvas')).toHaveAttribute('data-node-count', '2');
  });

  it('labels the all-capabilities layer with Code when CodeFile nodes are present', () => {
    renderPage();
    expect(screen.getByText('+ Items, Units & Code')).toBeInTheDocument();
  });

  it('reflects CodeFile capability in the all-layer aria-label (small-screen a11y)', () => {
    renderPage();
    expect(screen.getByRole('button', { name: 'Items, Units and Code layer' })).toBeInTheDocument();
  });

  it('falls back to the Items and Units aria-label when code capability is absent', () => {
    graphMock.mockReturnValue({
      nodes: NODES.filter((node) => node.type !== 'CodeFile'),
      edges: EDGES,
      loading: false,
      error: null,
      hasCodeTraceability: false,
    });
    renderPage();
    expect(screen.getByRole('button', { name: 'Items and Units layer' })).toBeInTheDocument();
  });

  it('retains the legacy Items & Units label when CodeFile capability is absent', () => {
    graphMock.mockReturnValue({
      nodes: NODES.filter((node) => node.type !== 'CodeFile'),
      edges: EDGES,
      loading: false,
      error: null,
      hasCodeTraceability: false,
    });
    renderPage();
    expect(screen.getByText('+ Items & Units')).toBeInTheDocument();
    expect(screen.queryByText('+ Items, Units & Code')).not.toBeInTheDocument();
  });

  it('marks the active button with aria-pressed', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /artifacts layer/i })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('button', { name: /items, units and code layer/i })).toHaveAttribute(
      'aria-pressed',
      'false',
    );
  });

  it('exposes a group role with accessible label', () => {
    renderPage();
    expect(screen.getByRole('group', { name: /graph layer/i })).toBeInTheDocument();
  });
});
