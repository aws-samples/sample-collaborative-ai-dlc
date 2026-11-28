import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('useResizablePanel width persistence', () => {
  const sidebar = {
    storageKey: 'test-sidebar-width',
    defaultWidth: 260,
    minWidth: 200,
    maxWidth: 420,
    viewportFraction: 0.3,
    anchor: 'left' as const,
  };
  let innerWidth: number;
  const setViewport = (width: number) => {
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: width });
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
  };
  beforeEach(() => {
    vi.useFakeTimers();
    localStorage.clear();
    innerWidth = window.innerWidth;
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1280 });
  });
  afterEach(() => {
    vi.useRealTimers();
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: innerWidth });
  });

  it('starts from the default width and does not persist it', () => {
    const { result } = renderHook(() => useResizablePanel(sidebar));
    expect(result.current.width).toBe(260);
    act(() => vi.runAllTimers());
    expect(localStorage.getItem(sidebar.storageKey)).toBeNull();
  });

  it('clamps a stored width on a narrow window without writing the clamp back', () => {
    localStorage.setItem(sidebar.storageKey, '320');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 390 });
    const { result } = renderHook(() => useResizablePanel(sidebar));
    expect(result.current.width).toBe(200);
    act(() => vi.runAllTimers());
    expect(localStorage.getItem(sidebar.storageKey)).toBe('320');
  });

  it('shrinks on a narrow window and grows back to the chosen width when it widens again', () => {
    localStorage.setItem(sidebar.storageKey, '320');
    const { result } = renderHook(() => useResizablePanel(sidebar));
    expect(result.current.width).toBe(320);
    setViewport(390);
    expect(result.current.width).toBe(200);
    setViewport(800);
    expect(result.current.width).toBe(240);
    setViewport(1280);
    expect(result.current.width).toBe(320);
    act(() => vi.runAllTimers());
    expect(localStorage.getItem(sidebar.storageKey)).toBe('320');
  });

  it('persists a keyboard resize after the debounce and keeps it across remounts', () => {
    const { result, unmount } = renderHook(() => useResizablePanel(sidebar));
    act(() => result.current.handleResizeKey(key('ArrowRight')));
    expect(result.current.width).toBe(276);
    expect(localStorage.getItem(sidebar.storageKey)).toBeNull();
    act(() => vi.advanceTimersByTime(250));
    expect(localStorage.getItem(sidebar.storageKey)).toBe('276');
    unmount();
    expect(renderHook(() => useResizablePanel(sidebar)).result.current.width).toBe(276);
  });

  it('persists a pointer drag and stops following the pointer after pointerup', () => {
    const { result } = renderHook(() => useResizablePanel(sidebar));
    act(() => {
      result.current.handleResizeStart({
        clientX: 260,
        preventDefault() {},
      } as unknown as React.PointerEvent<HTMLDivElement>);
    });
    act(() => {
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 300 }));
    });
    expect(result.current.width).toBe(300);
    act(() => {
      window.dispatchEvent(new PointerEvent('pointerup'));
      window.dispatchEvent(new PointerEvent('pointermove', { clientX: 400 }));
    });
    expect(result.current.width).toBe(300);
    act(() => vi.advanceTimersByTime(250));
    expect(localStorage.getItem(sidebar.storageKey)).toBe('300');
  });

  it('resets to the default width and persists the reset', () => {
    localStorage.setItem(sidebar.storageKey, '400');
    const { result } = renderHook(() => useResizablePanel(sidebar));
    expect(result.current.width).toBe(384);
    act(() => result.current.resetWidth());
    expect(result.current.width).toBe(260);
    act(() => vi.advanceTimersByTime(250));
    expect(localStorage.getItem(sidebar.storageKey)).toBe('260');
  });
});
