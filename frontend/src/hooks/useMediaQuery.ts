import { useEffect, useState } from 'react';

/**
 * Reactive `window.matchMedia` — re-renders when the query flips.
 * Used by AppShell to switch the side panels between inline grid columns
 * (large screens) and non-modal overlays (small screens).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => window.matchMedia(query).matches);

  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = (e: MediaQueryListEvent) => setMatches(e.matches);
    setMatches(mql.matches);
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
