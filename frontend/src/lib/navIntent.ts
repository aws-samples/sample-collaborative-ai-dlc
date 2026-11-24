import { querySessionOpen } from './queryClient';
import { onUserCacheEnded } from './persistentCache';
import {
  cancelHrefPrefetch,
  notifyNavigation,
  prefetchHref,
  setRoutePrefetchContext,
  type IntentTrigger,
  type RoutePrefetchContext,
} from './routePrefetch';

interface Target {
  element: Element;
  href: string;
}

function targetOf(target: EventTarget | null, respectOptOut = true): Target | undefined {
  const node =
    target instanceof Element ? target : target instanceof Node ? target.parentElement : null;
  const element = node?.closest('a[href], [data-prefetch-href]');
  if (!element || (respectOptOut && element.closest('[data-prefetch="none"]'))) return;
  const href = element.getAttribute('data-prefetch-href') ?? element.getAttribute('href');
  const linkTarget = element.getAttribute('target');
  if (
    !href?.startsWith('/') ||
    href.startsWith('//') ||
    href.includes('\\') ||
    (linkTarget && linkTarget !== '_self') ||
    element.hasAttribute('download') ||
    element.getAttribute('rel')?.split(/\s+/).includes('external') ||
    element.getAttribute('aria-disabled') === 'true' ||
    element.hasAttribute('disabled')
  )
    return;
  return { element, href };
}

/** One capture/passive listener set covers Links, nested icons and portaled menus. */
export function installNavIntent(
  getContext: () => RoutePrefetchContext,
  root: Document | HTMLElement = document,
): () => void {
  let armed: Target | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const restoreContext = setRoutePrefetchContext(getContext);
  const cancelTimer = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
  };
  const leave = () => {
    cancelTimer();
    if (armed) cancelHrefPrefetch(armed.href);
    armed = undefined;
  };
  const fire = (target: Target, trigger: IntentTrigger) => {
    cancelTimer();
    if (!querySessionOpen || !target.element.isConnected) return;
    // Attributes/role/session may have changed during the dwell.
    const current = targetOf(target.element);
    if (!current || current.href !== target.href) return;
    prefetchHref(target.href, { trigger, ...getContext() });
  };
  const arm = (event: Event, trigger: 'hover' | 'focus') => {
    if (trigger === 'hover' && (event as PointerEvent).pointerType === 'touch') return;
    const target = targetOf(event.target);
    if (target?.element === armed?.element) return;
    leave();
    if (!target || !querySessionOpen) return;
    armed = target;
    timer = setTimeout(() => fire(target, trigger), 200);
  };
  const out = (event: Event) => {
    if (!armed || !(event.target instanceof Node) || !armed.element.contains(event.target)) return;
    const related = (event as FocusEvent).relatedTarget;
    if (armed && related instanceof Node && armed.element.contains(related)) return;
    leave();
  };
  const immediate = (event: Event) => {
    const pointer = event as PointerEvent;
    if (
      event.type === 'pointerdown' &&
      (pointer.button !== 0 ||
        pointer.ctrlKey ||
        pointer.metaKey ||
        pointer.shiftKey ||
        pointer.altKey)
    )
      return;
    const destination = targetOf(event.target, false);
    cancelTimer();
    // An opt-out forbids warming, not yielding to the real navigation.
    if (destination) notifyNavigation(destination.href, getContext().user);
    const target = targetOf(event.target);
    if (target) fire(target, event.type === 'touchstart' ? 'touchstart' : 'pointerdown');
  };
  const handlers: Record<string, EventListener> = {
    pointerover: (event) => arm(event, 'hover'),
    pointerout: out,
    focusin: (event) => arm(event, 'focus'),
    focusout: out,
    pointerdown: immediate,
    touchstart: immediate,
  };
  for (const [name, handler] of Object.entries(handlers))
    root.addEventListener(name, handler, { capture: true, passive: true });
  const unsubscribe = onUserCacheEnded(leave);
  return () => {
    leave();
    unsubscribe();
    restoreContext();
    for (const [name, handler] of Object.entries(handlers))
      root.removeEventListener(name, handler, true);
  };
}
