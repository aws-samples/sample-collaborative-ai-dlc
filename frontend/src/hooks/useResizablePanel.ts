import { useState, useCallback, useEffect } from 'react';

interface ResizablePanelOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  // Never let the panel eat more than this fraction of the viewport.
  viewportFraction: number;
  // Which screen edge the panel is anchored to; drives the drag math and
  // which arrow key grows the panel.
  anchor: 'left' | 'right';
}

// Drag-to-resize state shared by the app's side panels: pointer-capture drag
// on the panel edge, keyboard arrows, double-click reset, and a debounced
// localStorage persistence of the chosen width.
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  viewportFraction,
  anchor,
}: ResizablePanelOptions) {
  const clamp = useCallback(
    (width: number) => {
      const max = Math.min(maxWidth, Math.round(window.innerWidth * viewportFraction));
      return Math.min(Math.max(width, minWidth), Math.max(max, minWidth));
    },
    [minWidth, maxWidth, viewportFraction],
  );

  const [width, setWidth] = useState(() => {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? clamp(stored) : defaultWidth;
  });

  useEffect(() => {
    const timer = setTimeout(() => {
      localStorage.setItem(storageKey, String(width));
    }, 250);
    return () => clearTimeout(timer);
  }, [storageKey, width]);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      const handle = e.currentTarget;
      handle.setPointerCapture(e.pointerId);
      const onMove = (ev: PointerEvent) => {
        const raw =
          anchor === 'right' ? document.documentElement.clientWidth - ev.clientX : ev.clientX;
        setWidth(clamp(raw));
      };
      const onEnd = () => {
        handle.removeEventListener('pointermove', onMove);
        handle.removeEventListener('pointerup', onEnd);
        handle.removeEventListener('pointercancel', onEnd);
      };
      handle.addEventListener('pointermove', onMove);
      handle.addEventListener('pointerup', onEnd);
      handle.addEventListener('pointercancel', onEnd);
    },
    [anchor, clamp],
  );

  const handleResizeKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = anchor === 'right' ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
      setWidth((w) => clamp(w + (grow ? 16 : -16)));
    },
    [anchor, clamp],
  );

  const resetWidth = useCallback(() => setWidth(defaultWidth), [defaultWidth]);

  return { width, handleResizeStart, handleResizeKey, resetWidth };
}
