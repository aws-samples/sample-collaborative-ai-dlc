import { useState, useCallback, useEffect, useRef } from 'react';

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

  // Teardown for an in-flight drag. Held in a ref so the unmount cleanup below
  // can remove the window listeners even if the component unmounts mid-drag
  // (e.g. a route change while dragging), which otherwise leaks the listeners
  // and keeps calling setWidth after unmount.
  const dragTeardownRef = useRef<(() => void) | null>(null);
  useEffect(() => () => dragTeardownRef.current?.(), []);

  const handleResizeStart = useCallback(
    (e: React.PointerEvent<HTMLDivElement>) => {
      e.preventDefault();
      // Track a delta from the drag's start, based on the effective (clamped)
      // width so a shrink-drag responds immediately after the viewport shrank.
      // Listeners go on `window` (not the handle) so the drag still ends if the
      // pointer is released off the 6px handle.
      const startX = e.clientX;
      const startWidth = clamp(width);
      const onMove = (ev: PointerEvent) => {
        const delta = anchor === 'right' ? startX - ev.clientX : ev.clientX - startX;
        setWidth(clamp(startWidth + delta));
      };
      const onEnd = () => {
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onEnd);
        window.removeEventListener('pointercancel', onEnd);
        dragTeardownRef.current = null;
      };
      dragTeardownRef.current = onEnd;
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onEnd);
      window.addEventListener('pointercancel', onEnd);
    },
    [anchor, clamp, width],
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
