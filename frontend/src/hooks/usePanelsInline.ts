import { useMediaQuery } from './useMediaQuery';

// Breakpoint (Tailwind lg): from here the shell lays its side panels out as
// grid columns and the sidebar lists every space; below it the panels are
// overlays and the sidebar is a drawer. One query for the shell and for every
// page that depends on which layout the reader is in.
export const PANELS_INLINE_MIN_WIDTH = 1024;
export const PANELS_INLINE_QUERY = `(min-width: ${PANELS_INLINE_MIN_WIDTH}px)`;

export function usePanelsInline(): boolean {
  return useMediaQuery(PANELS_INLINE_QUERY);
}
