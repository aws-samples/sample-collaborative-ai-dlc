import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useResizablePanel } from '@/hooks/useResizablePanel';

const options = {
  storageKey: 'test-panel-width',
  defaultWidth: 380,
  minWidth: 300,
  maxWidth: Number.POSITIVE_INFINITY,
  viewportFraction: 1,
  anchor: 'right' as const,
};
const key = (k: string) =>
  ({ key: k, preventDefault: () => {} }) as React.KeyboardEvent<HTMLDivElement>;
const grow = (result: { current: ReturnType<typeof useResizablePanel> }, times: number) => {
  for (let i = 0; i < times; i += 1) act(() => result.current.handleResizeKey(key('ArrowLeft')));
};

describe('useResizablePanel', () => {
  let innerWidth: number;
  beforeEach(() => {
    localStorage.clear();
    innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1920 });
  });
  afterEach(() => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  it('grows until only the reserved width is left', () => {
    const { result } = renderHook(() => useResizablePanel({ ...options, reserveWidth: 620 }));
    grow(result, 200);
    expect(result.current.width).toBe(1300);
    expect(result.current.effectiveMaxWidth).toBe(1300);
  });

  it('keeps the fixed and viewport caps for panels that set them', () => {
    const { result } = renderHook(() =>
      useResizablePanel({ ...options, maxWidth: 420, viewportFraction: 0.3 }),
    );
    grow(result, 200);
    expect(result.current.width).toBe(420);
  });

  it('never shrinks below the minimum, even when little is left', () => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    const { result } = renderHook(() => useResizablePanel({ ...options, reserveWidth: 700 }));
    grow(result, 10);
    expect(result.current.width).toBe(300);
    expect(result.current.effectiveMaxWidth).toBe(300);
  });

  it('clamps a stored width to what the window allows', () => {
    localStorage.setItem('test-panel-width', '5000');
    const { result } = renderHook(() => useResizablePanel({ ...options, reserveWidth: 620 }));
    expect(result.current.width).toBe(1300);
  });
});
