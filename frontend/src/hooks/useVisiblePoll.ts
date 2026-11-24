import { useEffect, useRef } from 'react';

export interface VisiblePollOptions {
  /** On return to a visible tab, run once if the last run is older than this (default: intervalMs). */
  runOnVisibleIfStaleMs?: number;
  /** Run once on start instead of waiting a full interval. */
  immediate?: boolean;
}

/**
 * Calls `fn` every `intervalMs` while the document is visible. Paused while
 * hidden; the next call is scheduled after the previous one settles, so slow
 * calls never overlap. `null` disables polling.
 */
export function useVisiblePoll(
  fn: () => unknown,
  intervalMs: number | null,
  { runOnVisibleIfStaleMs, immediate = false }: VisiblePollOptions = {},
): void {
  const fnRef = useRef(fn);
  fnRef.current = fn;

  useEffect(() => {
    if (intervalMs === null) return;
    const staleAfter = runOnVisibleIfStaleMs ?? intervalMs;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let inFlight = false;
    let disposed = false;
    let lastRunAt = Date.now();

    const isHidden = () => document.visibilityState === 'hidden';
    const stop = () => {
      if (timer !== null) clearTimeout(timer);
      timer = null;
    };
    const schedule = (delay: number) => {
      stop();
      if (disposed || isHidden()) return;
      timer = setTimeout(run, Math.max(0, delay));
    };
    const settled = () => {
      inFlight = false;
      schedule(intervalMs);
    };
    function run() {
      timer = null;
      if (disposed || inFlight || isHidden()) return;
      inFlight = true;
      lastRunAt = Date.now();
      let result: unknown;
      try {
        result = fnRef.current();
      } catch {
        result = undefined;
      }
      Promise.resolve(result).then(settled, settled);
    }

    const onVisibilityChange = () => {
      if (isHidden()) {
        stop();
        return;
      }
      if (inFlight) return;
      const elapsed = Date.now() - lastRunAt;
      if (elapsed >= staleAfter) run();
      else schedule(elapsed < intervalMs ? intervalMs - elapsed : intervalMs);
    };

    document.addEventListener('visibilitychange', onVisibilityChange);
    if (immediate) run();
    else schedule(intervalMs);

    return () => {
      disposed = true;
      stop();
      document.removeEventListener('visibilitychange', onVisibilityChange);
    };
  }, [intervalMs, runOnVisibleIfStaleMs, immediate]);
}
