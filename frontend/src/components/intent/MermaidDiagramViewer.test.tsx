import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ArtifactMarkdown } from '@/components/intent/ArtifactMarkdown';
import { svgFile, svgSize, withSvgId } from '@/components/intent/MermaidDiagramViewer';

let renderedSvg = '';
vi.mock('mermaid', () => ({
  default: {
    initialize: vi.fn(),
    render: vi.fn(async (id: string) => {
      renderedSvg = `<svg id="${id}" role="img" aria-label="diagram" viewBox="0 0 2400 300" style="max-width: 2400px;"><style>#${id} .node{fill:red}</style><text>diagram</text></svg>`;
      return { svg: renderedSvg, bindFunctions: vi.fn() };
    }),
  },
}));

const DIAGRAM = '```mermaid\ngraph LR\n  A-->B\n```';

describe('svg helpers', () => {
  it('reads the size from the viewBox', () => {
    expect(svgSize('<svg viewBox="-8 -8 2400.5 300">')).toEqual({ width: 2400.5, height: 300 });
    expect(svgSize('<svg width="10">')).toBeNull();
  });

  it('moves every reference to the diagram id to a new one', () => {
    const svg = '<svg id="m-1"><style>#m-1 .a{}</style><path marker-end="url(#m-1_end)"/></svg>';
    expect(withSvgId(svg, 'm-1', 'm-1-full')).toBe(
      '<svg id="m-1-full"><style>#m-1-full .a{}</style><path marker-end="url(#m-1-full_end)"/></svg>',
    );
  });

  it('makes a standalone file on the background the diagram was drawn on', () => {
    const file = svgFile('<svg id="m" style="max-width: 10px;"></svg>', 'rgb(1, 2, 3)');
    expect(file).toMatch(/^<\?xml version="1.0" encoding="UTF-8"\?>\n<svg xmlns=/);
    expect(file).toContain('style="background-color: rgb(1, 2, 3); max-width: 10px;"');
    expect(svgFile('<svg id="m"></svg>', 'white')).toContain('style="background-color: white"');
  });
});

describe('Mermaid diagram viewer', () => {
  let createObjectURL: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    createObjectURL = vi.fn(() => 'blob:diagram');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  const renderDiagram = async () => {
    render(<ArtifactMarkdown content={DIAGRAM} />);
    await waitFor(() => expect(screen.getByRole('img', { name: 'diagram' })).toBeInTheDocument());
  };

  it('opens the diagram at its own size, under its own id', async () => {
    await renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: 'View diagram full size' }));
    const dialog = await screen.findByRole('dialog');
    const region = within(dialog).getByRole('region', { name: 'Diagram, full size' });
    const content = region.firstElementChild as HTMLElement;
    expect(content.style.width).toBe('2400px');
    expect(content.style.height).toBe('300px');
    const copy = content.querySelector('svg')!;
    const original = document.querySelector('.mermaid-diagram svg')!;
    expect(copy.id).toBe(`${original.id}-full`);
    expect(copy.querySelector('style')!.textContent).toContain(`#${original.id}-full .node`);
    expect(within(dialog).getByRole('button', { name: 'Actual size' })).toHaveTextContent('100%');
  });

  it('zooms with the buttons and the keyboard', async () => {
    await renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: 'View diagram full size' }));
    const dialog = await screen.findByRole('dialog');
    const actual = within(dialog).getByRole('button', { name: 'Actual size' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Zoom in' }));
    expect(actual).toHaveTextContent('125%');
    const region = within(dialog).getByRole('region', { name: 'Diagram, full size' });
    fireEvent.keyDown(region, { key: '-' });
    fireEvent.keyDown(region, { key: '-' });
    expect(actual).toHaveTextContent('80%');
    fireEvent.keyDown(region, { key: '0' });
    expect(actual).toHaveTextContent('100%');
    expect((region.firstElementChild as HTMLElement).style.width).toBe('2400px');
  });

  it('keeps the zoom keys working after a toolbar button was used', async () => {
    await renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: 'View diagram full size' }));
    const dialog = await screen.findByRole('dialog');
    const zoomIn = within(dialog).getByRole('button', { name: 'Zoom in' });
    zoomIn.focus();
    fireEvent.click(zoomIn);
    fireEvent.keyDown(zoomIn, { key: '+' });
    expect(within(dialog).getByRole('button', { name: 'Actual size' })).toHaveTextContent('156%');
  });

  it('fits the diagram inside the padding, without scroll bars', async () => {
    await renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: 'View diagram full size' }));
    const dialog = await screen.findByRole('dialog');
    const region = within(dialog).getByRole('region', { name: 'Diagram, full size' });
    Object.defineProperty(region, 'clientWidth', { configurable: true, value: 1232 });
    Object.defineProperty(region, 'clientHeight', { configurable: true, value: 832 });
    region.style.padding = '16px';
    fireEvent.click(within(dialog).getByRole('button', { name: 'Fit to window' }));
    // (1232 - 32) / 2400 = 0.5, smaller than (832 - 32) / 300.
    expect((region.firstElementChild as HTMLElement).style.width).toBe('1200px');
  });

  it('zooms with Ctrl and the scroll wheel, but leaves plain scrolling alone', async () => {
    await renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: 'View diagram full size' }));
    const dialog = await screen.findByRole('dialog');
    const region = within(dialog).getByRole('region', { name: 'Diagram, full size' });
    const actual = within(dialog).getByRole('button', { name: 'Actual size' });
    fireEvent.wheel(region, { deltaY: 100 });
    expect(actual).toHaveTextContent('100%');
    fireEvent.wheel(region, { deltaY: -100, ctrlKey: true });
    expect(Number.parseInt(actual.textContent!, 10)).toBeGreaterThan(100);
  });

  it('downloads the diagram as an SVG file', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const later = vi.spyOn(window, 'setTimeout');
    await renderDiagram();
    fireEvent.click(screen.getByRole('button', { name: 'Download diagram as SVG' }));
    expect(click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(blob.type).toBe('image/svg+xml;charset=utf-8');
    const text = await blob.text();
    expect(text).toContain('xmlns="http://www.w3.org/2000/svg"');
    expect(text).toContain('<text>diagram</text>');
    const link = click.mock.instances[0] as unknown as HTMLAnchorElement;
    expect(link.download).toBe('diagram.svg');
    // The URL outlives the click, so a download that starts late still has it.
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();
    const revoke = later.mock.calls.find(([, ms]) => ms === 10_000)?.[0] as () => void;
    revoke();
    expect(URL.revokeObjectURL).toHaveBeenCalledWith('blob:diagram');
  });
});
