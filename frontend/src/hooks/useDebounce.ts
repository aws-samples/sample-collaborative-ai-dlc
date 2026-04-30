import { useEffect, useRef } from 'react';

export function useDebounce<T extends (...args: any[]) => void>(
  callback: T,
  delay: number
): T {
  const timeoutRef = useRef<number | null>(null);
  const callbackRef = useRef(callback);
  const pendingArgsRef = useRef<any[] | null>(null);

  useEffect(() => {
    callbackRef.current = callback;
  }, [callback]);

  // On unmount: flush any pending debounced call instead of dropping it
  useEffect(() => {
    return () => {
      if (timeoutRef.current) {
        clearTimeout(timeoutRef.current);
        timeoutRef.current = null;
      }
      if (pendingArgsRef.current) {
        callbackRef.current(...pendingArgsRef.current);
        pendingArgsRef.current = null;
      }
    };
  }, []);

  return ((...args: any[]) => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
    pendingArgsRef.current = args;
    timeoutRef.current = window.setTimeout(() => {
      pendingArgsRef.current = null;
      callbackRef.current(...args);
    }, delay);
  }) as T;
}
