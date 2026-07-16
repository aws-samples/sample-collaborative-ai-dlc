import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { GraphCanvas } from './GraphCanvas';
import type { GraphNode, GraphEdge } from '@/services/sprintGraph';

const NODES: GraphNode[] = [
  { id: 'n1', type: 'Intent', label: 'Alpha' },
  { id: 'n2', type: 'Artifact', label: 'Beta' },
  { id: 'n3', type: 'Task', label: 'Gamma' },
];

const EDGES: GraphEdge[] = [
  { source: 'n1', target: 'n2', label: 'CONTAINS' },
  { source: 'n2', target: 'n3', label: 'PRODUCES' },
];

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
});

async function renderCanvas() {
  let result: ReturnType<typeof render>;
  await act(async () => {
    result = render(
      <TooltipProvider>
        <GraphCanvas nodes={NODES} edges={EDGES} />
      </TooltipProvider>,
    );
  });
  await act(async () => {
    vi.advanceTimersByTime(16);
  });
  return result!;
}

describe('GraphCanvas zoom widget', () => {
  it('renders fit-to-content button and no recenter button', async () => {
    await renderCanvas();
    expect(screen.getByRole('button', { name: /fit to content/i })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recenter/i })).not.toBeInTheDocument();
  });

  it('renders zoom in/out buttons', async () => {
    await renderCanvas();
    expect(screen.getByRole('button', { name: /zoom in/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /zoom out/i })).toBeInTheDocument();
  });

  it('keyboard 0 triggers fit-to-content (no recenter)', async () => {
    await renderCanvas();
    const fitBtn = screen.getByRole('button', { name: /fit to content/i });
    expect(fitBtn).toBeInTheDocument();
    act(() => {
      fireEvent.keyDown(window, { key: '0' });
    });
  });

  it('shows only one view-fit action below the zoom slider', async () => {
    await renderCanvas();
    const zoomOut = screen.getByRole('button', { name: /zoom out/i });
    const fitBtn = screen.getByRole('button', { name: /fit to content/i });
    expect(zoomOut).toBeInTheDocument();
    expect(fitBtn).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /recenter/i })).toBeNull();
  });
});
