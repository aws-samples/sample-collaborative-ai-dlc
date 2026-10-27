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

describe('GraphCanvas wheel and pinch zoom', () => {
  function wheel(target: Element, init: WheelEventInit) {
    const event = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
    act(() => {
      target.dispatchEvent(event);
    });
    return event;
  }

  function viewBoxOf(svg: SVGSVGElement) {
    const [x, y, width, height] = svg.getAttribute('viewBox')!.split(' ').map(Number);
    return { x, y, width, height };
  }

  function canvasSvg(container: HTMLElement) {
    const svg = container.querySelector('svg.select-none') as SVGSVGElement;
    expect(svg).not.toBeNull();
    svg.getBoundingClientRect = () =>
      ({
        left: 0,
        top: 0,
        width: 800,
        height: 600,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
      }) as DOMRect;
    return svg;
  }

  async function renderSizedCanvas() {
    const { container } = await renderCanvas();
    return canvasSvg(container);
  }

  it('zooms only the graph on a trackpad pinch, in proportion to the gesture', async () => {
    const svg = await renderSizedCanvas();
    const before = viewBoxOf(svg);
    const event = wheel(svg, { ctrlKey: true, deltaY: -5, clientX: 200, clientY: 150 });
    expect(event.defaultPrevented).toBe(true);
    const after = viewBoxOf(svg);
    expect(after.width).toBeCloseTo(before.width * Math.exp(-0.05));
    // The world point under the pointer (a quarter into the canvas) stays put.
    expect(after.x + 0.25 * after.width).toBeCloseTo(before.x + 0.25 * before.width);
    expect(after.y + 0.25 * after.height).toBeCloseTo(before.y + 0.25 * before.height);
  });

  it('caps a Ctrl+mouse-wheel notch at about 10%', async () => {
    const svg = await renderSizedCanvas();
    const before = viewBoxOf(svg).width;
    wheel(svg, { ctrlKey: true, deltaY: 100, clientX: 400, clientY: 300 });
    expect(viewBoxOf(svg).width).toBeCloseTo(before * Math.exp(0.1));
  });

  it('keeps the fixed step for a plain wheel and ignores horizontal scroll', async () => {
    const svg = await renderSizedCanvas();
    const before = viewBoxOf(svg).width;
    expect(wheel(svg, { deltaY: 100, clientX: 400, clientY: 300 }).defaultPrevented).toBe(true);
    expect(viewBoxOf(svg).width).toBeCloseTo(before * 1.08);
    wheel(svg, { deltaX: 100, clientX: 400, clientY: 300 });
    expect(viewBoxOf(svg).width).toBeCloseTo(before * 1.08);
  });

  it('cancels a pinch over the overlays but lets them scroll normally', async () => {
    await renderSizedCanvas();
    const overlay = screen.getByRole('button', { name: /zoom in/i });
    expect(wheel(overlay, { ctrlKey: true, deltaY: -5 }).defaultPrevented).toBe(true);
    expect(wheel(overlay, { deltaY: 100 }).defaultPrevented).toBe(false);
  });

  it('cancels Safari gesture events so Safari does not zoom the page', async () => {
    const svg = await renderSizedCanvas();
    for (const type of ['gesturestart', 'gesturechange', 'gestureend']) {
      const event = new Event(type, { bubbles: true, cancelable: true });
      act(() => {
        svg.dispatchEvent(event);
      });
      expect(event.defaultPrevented, type).toBe(true);
    }
  });

  it('handles a pinch once an error state clears', async () => {
    let result: ReturnType<typeof render>;
    await act(async () => {
      result = render(
        <TooltipProvider>
          <GraphCanvas nodes={NODES} edges={EDGES} error="boom" />
        </TooltipProvider>,
      );
    });
    await act(async () => {
      result!.rerender(
        <TooltipProvider>
          <GraphCanvas nodes={NODES} edges={EDGES} error={null} />
        </TooltipProvider>,
      );
      vi.advanceTimersByTime(16);
    });
    const svg = canvasSvg(result!.container);
    expect(wheel(svg, { ctrlKey: true, deltaY: -5 }).defaultPrevented).toBe(true);
  });
});
