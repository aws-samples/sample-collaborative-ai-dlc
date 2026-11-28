import { useCallback, useRef } from 'react';

/**
 * Focus return for a controlled Radix dialog that has no `Trigger`.
 *
 * Radix restores focus to the trigger element on close; a dialog driven only
 * by an `open` prop has none, so focus falls to `<body>` (WCAG 2.4.3). This
 * remembers the element that was focused when `open` turned true and hands it
 * back through `onCloseAutoFocus`.
 *
 * The capture happens during the render that opens the dialog, before the
 * dialog mounts and moves focus, so the recorded element is the control that
 * requested the dialog.
 */
export function useReturnFocus(open: boolean) {
  const target = useRef<HTMLElement | null>(null);
  const wasOpen = useRef(false);
  if (open && !wasOpen.current) {
    const active = document.activeElement;
    target.current = active instanceof HTMLElement && active !== document.body ? active : null;
  }
  wasOpen.current = open;

  return useCallback((event: Event) => {
    const element = target.current;
    target.current = null;
    if (!element?.isConnected) return;
    event.preventDefault();
    element.focus();
  }, []);
}
