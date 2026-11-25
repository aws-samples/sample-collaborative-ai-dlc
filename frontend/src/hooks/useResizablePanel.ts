import { useState, useCallback, useEffect, useRef } from 'react';

interface ResizablePanelOptions {
  storageKey: string;
  defaultWidth: number;
  minWidth: number;
  maxWidth: number;
  // Never let the panel eat more than this fraction of the viewport.
  viewportFraction: number;
  // Pixels of the viewport kept for the rest of the layout (other panels and
  // the main column), so the panel can grow until only that is left.
  reserveWidth?: number;
  // Which screen edge the panel is anchored to; drives the drag math and
  // which arrow key grows the panel.
  anchor: 'left' | 'right';
}

const PERSIST_DEBOUNCE_MS = 250;

function readStoredWidth(storageKey: string): number | null {
  try {
    const stored = Number(localStorage.getItem(storageKey));
    return Number.isFinite(stored) && stored > 0 ? stored : null;
  } catch {
    return null;
  }
}

function useViewportWidth(): number {
  const [viewportWidth, setViewportWidth] = useState(() => window.innerWidth);
  useEffect(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return viewportWidth;
}

// Drag-to-resize state shared by the app's side panels: pointer-capture drag
// on the panel edge, keyboard arrows, double-click reset, and a debounced
// localStorage persistence of the chosen width.
//
// Two widths live here on purpose. `preferredWidth` is what the user chose
// (drag, keyboard, reset) and is the only value ever persisted. The returned
// `width` is that preference clamped against the CURRENT viewport, so a
// narrow window shrinks the panel without forgetting the preference, and the
// panel grows back once the window is wide again.
export function useResizablePanel({
  storageKey,
  defaultWidth,
  minWidth,
  maxWidth,
  viewportFraction,
  reserveWidth = 0,
  anchor,
}: ResizablePanelOptions) {
  const viewportWidth = useViewportWidth();

  const clamp = useCallback(
    (width: number) => {
      const max = Math.min(
        maxWidth,
        Math.round(viewportWidth * viewportFraction),
        viewportWidth - reserveWidth,
      );
      return Math.min(Math.max(width, minWidth), Math.max(max, minWidth));
    },
    [minWidth, maxWidth, viewportFraction, reserveWidth, viewportWidth],
  );

  const [preferredWidth, setPreferredWidth] = useState(
    () => readStoredWidth(storageKey) ?? defaultWidth,
  );
  const width = clamp(preferredWidth);

  // Persist only widths the user explicitly chose — never the clamped render
  // value — so a visit on a narrow window cannot shrink the panel for good.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const persistWidth = useCallback(
    (nextWidth: number) => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        try {
          localStorage.setItem(storageKey, String(nextWidth));
        } catch {
          // Storage unavailable (private mode, quota): the width is session-only.
        }
      }, PERSIST_DEBOUNCE_MS);
    },
    [storageKey],
  );
  useEffect(
    () => () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    },
    [],
  );

  const chooseWidth = useCallback(
    (nextWidth: number) => {
      setPreferredWidth(nextWidth);
      persistWidth(nextWidth);
    },
    [persistWidth],
  );

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
      const startWidth = width;
      const onMove = (ev: PointerEvent) => {
        const delta = anchor === 'right' ? startX - ev.clientX : ev.clientX - startX;
        chooseWidth(clamp(startWidth + delta));
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
    [anchor, chooseWidth, clamp, width],
  );

  const handleResizeKey = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const grow = anchor === 'right' ? e.key === 'ArrowLeft' : e.key === 'ArrowRight';
      chooseWidth(clamp(width + (grow ? 16 : -16)));
    },
    [anchor, chooseWidth, clamp, width],
  );

  const resetWidth = useCallback(() => chooseWidth(defaultWidth), [chooseWidth, defaultWidth]);

  // The widest the panel can currently get, for the separator's aria-valuemax.
  const effectiveMaxWidth = clamp(Number.POSITIVE_INFINITY);

  return { width, effectiveMaxWidth, handleResizeStart, handleResizeKey, resetWidth };
}
