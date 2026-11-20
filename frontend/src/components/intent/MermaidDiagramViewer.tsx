import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Download, Maximize2, Scan, ZoomIn, ZoomOut } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';

const MIN_SCALE = 0.1;
const MAX_SCALE = 8;
const STEP = 1.25;
const REVOKE_AFTER_MS = 10_000;

/** The diagram's own size, from its viewBox. Null when it has none. */
export function svgSize(svg: string): { width: number; height: number } | null {
  const match = /viewBox="\s*[-\d.]+[\s,]+[-\d.]+[\s,]+([\d.]+)[\s,]+([\d.]+)\s*"/.exec(svg);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return width > 0 && height > 0 ? { width, height } : null;
}

/**
 * The same SVG under another id. Mermaid scopes the diagram's styles and
 * markers to its element id, so a second copy on the page needs its own.
 */
export function withSvgId(svg: string, fromId: string, toId: string): string {
  return svg.split(fromId).join(toId);
}

/** A standalone SVG file for the diagram, on the background it was drawn for. */
export function svgFile(svg: string, background: string | null): string {
  let file = svg.includes('xmlns="http://www.w3.org/2000/svg"')
    ? svg
    : svg.replace(/^<svg\b/, '<svg xmlns="http://www.w3.org/2000/svg"');
  if (background) {
    file = file.replace(/^<svg\b([^>]*?)style="/, `<svg$1style="background-color: ${background}; `);
    if (!file.includes(`background-color: ${background}`))
      file = file.replace(/^<svg\b/, `<svg style="background-color: ${background}"`);
  }
  return `<?xml version="1.0" encoding="UTF-8"?>\n${file}`;
}

export function downloadSvg(svg: string, filename: string, background: string | null) {
  const url = URL.createObjectURL(
    new Blob([svgFile(svg, background)], { type: 'image/svg+xml;charset=utf-8' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Some browsers start the download after click() returns; revoking at once
  // can cancel it or save an empty file.
  window.setTimeout(() => URL.revokeObjectURL(url), REVOKE_AFTER_MS);
}

const clampScale = (scale: number) => Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));

interface MermaidDiagramActionsProps {
  svg: string;
  diagramId: string;
  /** Element whose background the diagram was drawn on (for the downloaded file). */
  backgroundFrom: () => HTMLElement | null;
}

/** "View full size" and "Download SVG" for one rendered Mermaid diagram. */
export function MermaidDiagramActions({
  svg,
  diagramId,
  backgroundFrom,
}: MermaidDiagramActionsProps) {
  const [open, setOpen] = useState(false);
  const background = () => {
    const element = backgroundFrom();
    return element ? getComputedStyle(element).backgroundColor || null : null;
  };
  return (
    <>
      <div className="flex justify-end gap-1 border-b px-2 py-1">
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          aria-label="View diagram full size"
          title="View full size"
          onClick={() => setOpen(true)}
        >
          <Maximize2 className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          className="h-7 w-7"
          aria-label="Download diagram as SVG"
          title="Download SVG"
          onClick={() => downloadSvg(svg, 'diagram.svg', background())}
        >
          <Download className="h-3.5 w-3.5" aria-hidden="true" />
        </Button>
      </div>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="grid h-[92vh] w-[96vw] max-w-none grid-rows-[auto_minmax(0,1fr)] gap-0 overflow-hidden p-0">
          <DialogHeader className="border-b px-6 py-3 pr-14">
            <DialogTitle className="text-base">Diagram</DialogTitle>
            <DialogDescription className="sr-only">
              Zoom with the buttons, the plus and minus keys, or Ctrl or Command with the scroll
              wheel. Drag to move around.
            </DialogDescription>
          </DialogHeader>
          {open && (
            <DiagramViewer
              svg={withSvgId(svg, diagramId, `${diagramId}-full`)}
              onDownload={() => downloadSvg(svg, 'diagram.svg', background())}
            />
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}

function DiagramViewer({ svg, onDownload }: { svg: string; onDownload: () => void }) {
  const size = useMemo(() => svgSize(svg), [svg]);
  const viewportRef = useRef<HTMLDivElement>(null);
  // Opens at the diagram's own size: the size it was drawn to be read at.
  const [scale, setScale] = useState(1);
  const scaleRef = useRef(1);
  const drag = useRef<{ x: number; y: number } | null>(null);

  // Zoom about a point of the viewport (its centre by default), so what is
  // under the pointer or in the middle stays in place.
  const zoomTo = useCallback((next: number, at?: { x: number; y: number }) => {
    const viewport = viewportRef.current;
    const current = scaleRef.current;
    const target = clampScale(next);
    scaleRef.current = target;
    setScale(target);
    if (!viewport || target === current) return;
    const px = at?.x ?? viewport.clientWidth / 2;
    const py = at?.y ?? viewport.clientHeight / 2;
    const ratio = target / current;
    const left = (viewport.scrollLeft + px) * ratio - px;
    const top = (viewport.scrollTop + py) * ratio - py;
    // After the resized content has laid out.
    window.requestAnimationFrame(() => {
      viewport.scrollLeft = left;
      viewport.scrollTop = top;
    });
  }, []);
  const fit = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport || !size) return;
    // clientWidth and clientHeight include the viewport's padding.
    const style = getComputedStyle(viewport);
    const padX = Number.parseFloat(style.paddingLeft) + Number.parseFloat(style.paddingRight) || 0;
    const padY = Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom) || 0;
    const next = clampScale(
      Math.min(
        (viewport.clientWidth - padX) / size.width,
        (viewport.clientHeight - padY) / size.height,
      ),
    );
    scaleRef.current = next;
    setScale(next);
  }, [size]);

  // Ctrl/Command + wheel (and a trackpad pinch, which arrives as one) zooms
  // the diagram instead of the page; it needs a non-passive listener.
  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const onWheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const rect = viewport.getBoundingClientRect();
      zoomTo(scaleRef.current * Math.exp(-event.deltaY * 0.01), {
        x: event.clientX - rect.left,
        y: event.clientY - rect.top,
      });
    };
    viewport.addEventListener('wheel', onWheel, { passive: false });
    return () => viewport.removeEventListener('wheel', onWheel);
  }, [zoomTo]);

  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === '+' || event.key === '=') zoomTo(scale * STEP);
    else if (event.key === '-' || event.key === '_') zoomTo(scale / STEP);
    else if (event.key === '0') zoomTo(1);
    else return;
    event.preventDefault();
  };

  return (
    // The zoom keys work from the diagram and from the toolbar buttons alike.
    <div className="relative min-h-0" onKeyDown={onKeyDown}>
      <div
        ref={viewportRef}
        role="region"
        aria-label="Diagram, full size"
        tabIndex={0}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          drag.current = { x: event.clientX, y: event.clientY };
          event.currentTarget.setPointerCapture?.(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (!drag.current) return;
          event.currentTarget.scrollLeft -= event.clientX - drag.current.x;
          event.currentTarget.scrollTop -= event.clientY - drag.current.y;
          drag.current = { x: event.clientX, y: event.clientY };
        }}
        onPointerUp={() => {
          drag.current = null;
        }}
        onPointerCancel={() => {
          drag.current = null;
        }}
        className="h-full w-full cursor-grab overflow-auto bg-background p-4 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring active:cursor-grabbing"
      >
        <div
          className="mermaid-diagram mx-auto [&_svg]:h-full! [&_svg]:w-full! [&_svg]:max-w-none!"
          style={
            size ? { width: size.width * scale, height: size.height * scale } : { zoom: scale }
          }
          dangerouslySetInnerHTML={{ __html: svg }}
        />
      </div>
      <div className="absolute bottom-3 right-3 flex items-center gap-1 rounded-md border bg-background/95 p-1 shadow-sm">
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom out"
          onClick={() => zoomTo(scale / STEP)}
          disabled={scale <= MIN_SCALE}
        >
          <ZoomOut className="h-4 w-4" aria-hidden="true" />
        </Button>
        <button
          type="button"
          className="min-w-12 rounded px-1 text-xs tabular-nums text-muted-foreground hover:bg-muted"
          aria-label="Actual size"
          title="Actual size"
          onClick={() => zoomTo(1)}
        >
          {Math.round(scale * 100)}%
        </button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Zoom in"
          onClick={() => zoomTo(scale * STEP)}
          disabled={scale >= MAX_SCALE}
        >
          <ZoomIn className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Fit to window"
          title="Fit to window"
          onClick={fit}
          disabled={!size}
        >
          <Scan className="h-4 w-4" aria-hidden="true" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          className="h-7 w-7"
          aria-label="Download diagram as SVG"
          title="Download SVG"
          onClick={onDownload}
        >
          <Download className="h-4 w-4" aria-hidden="true" />
        </Button>
      </div>
    </div>
  );
}
