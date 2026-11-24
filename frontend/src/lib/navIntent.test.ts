import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryClient } from './queryClient';
import { bindUserCache, endUserCache } from './persistentCache';
const mocks = vi.hoisted(() => ({
  prefetch: vi.fn(),
  cancel: vi.fn(),
  navigate: vi.fn(),
  restore: vi.fn(),
}));
vi.mock('./routePrefetch', () => ({
  prefetchHref: mocks.prefetch,
  cancelHrefPrefetch: mocks.cancel,
  notifyNavigation: mocks.navigate,
  setRoutePrefetchContext: () => mocks.restore,
}));
import { installNavIntent } from './navIntent';

let uninstall: () => void;
function link(href = '/workflows', attributes = '') {
  const holder = document.createElement('div');
  holder.innerHTML = `<a href="${href}" ${attributes}><span>Link</span></a>`;
  document.body.append(holder);
  return holder.firstElementChild!;
}
function pointer(target: Element, type: string, properties: Record<string, unknown> = {}) {
  const event = new Event(type, { bubbles: true });
  Object.assign(event, { pointerType: 'mouse', button: 0, ...properties });
  target.dispatchEvent(event);
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  queryClient.clear();
  uninstall = installNavIntent(() => ({
    user: { isPlatformAdmin: true },
    currentHref: '/dashboard',
  }));
});
afterEach(() => {
  uninstall();
  document.body.replaceChildren();
  queryClient.clear();
  vi.useRealTimers();
});

describe('delegated navigation intent', () => {
  it('unrelated pointerout does not cancel the keyboard-focused link', async () => {
    const a = link('/workflows');
    const b = link('/blocks') as HTMLAnchorElement;
    b.focus();
    pointer(a, 'pointerout');
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith(
      '/blocks',
      expect.objectContaining({ trigger: 'focus' }),
    );
    expect(document.activeElement).toBe(b);
  });

  it('warms nested Link targets once at 200 ms without per-link handlers', async () => {
    const row = link();
    pointer(row.firstElementChild!, 'pointerover');
    await vi.advanceTimersByTimeAsync(199);
    expect(mocks.prefetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith(
      '/workflows',
      expect.objectContaining({ trigger: 'hover' }),
    );
    pointer(row, 'pointerover');
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).toHaveBeenCalledTimes(1);
  });

  it('pointerout at 199 ms cancels dwell and still-queued work', async () => {
    const row = link();
    pointer(row, 'pointerover');
    await vi.advanceTimersByTimeAsync(199);
    pointer(row, 'pointerout');
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.cancel).toHaveBeenCalledWith('/workflows');
  });

  it('moving across rows only warms the rested row; moving within it does not cancel', async () => {
    const a = link('/workflows');
    const b = link('/blocks');
    pointer(a, 'pointerover');
    await vi.advanceTimersByTimeAsync(199);
    pointer(b, 'pointerover');
    pointer(b, 'pointerout', { relatedTarget: b.firstElementChild });
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith('/blocks', expect.anything());
  });

  it('pointerdown and touchstart fire immediately, but touch scrolling does not', async () => {
    const a = link();
    pointer(a, 'pointerover', { pointerType: 'touch' });
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).not.toHaveBeenCalled();
    pointer(a, 'touchstart');
    expect(mocks.prefetch).toHaveBeenLastCalledWith(
      '/workflows',
      expect.objectContaining({ trigger: 'touchstart' }),
    );
    pointer(a, 'pointerdown');
    expect(mocks.navigate).toHaveBeenLastCalledWith('/workflows', { isPlatformAdmin: true });
    expect(mocks.prefetch).toHaveBeenLastCalledWith(
      '/workflows',
      expect.objectContaining({ trigger: 'pointerdown' }),
    );
  });

  it('keyboard focus dwells without moving focus and focusout cancels', async () => {
    const a = link() as HTMLAnchorElement;
    a.focus();
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith(
      '/workflows',
      expect.objectContaining({ trigger: 'focus' }),
    );
    expect(document.activeElement).toBe(a);
    a.blur();
    expect(mocks.cancel).toHaveBeenCalledWith('/workflows');
  });

  it.each([
    'data-prefetch="none"',
    'target="_blank"',
    'download',
    'rel="noopener external"',
    'aria-disabled="true"',
  ])('ignores opted-out or non-navigation anchors: %s', async (attributes) => {
    const a = link('/workflows', attributes);
    pointer(a, 'pointerover');
    await vi.advanceTimersByTimeAsync(200);
    pointer(a, 'pointerdown');
    expect(mocks.prefetch).not.toHaveBeenCalled();
  });

  it.each([
    'https://example.com',
    '//example.com',
    'mailto:x@example.com',
    '#top',
    '/\\example.com',
  ])('ignores unsafe/external href %s', async (href) => {
    const a = link(href);
    pointer(a, 'pointerover');
    await vi.advanceTimersByTimeAsync(200);
    pointer(a, 'pointerdown');
    expect(mocks.prefetch).not.toHaveBeenCalled();
  });

  it('respects ancestor opt-out, including opt-out added during the dwell', async () => {
    const a = link();
    pointer(a, 'pointerover');
    a.parentElement!.setAttribute('data-prefetch', 'none');
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).not.toHaveBeenCalled();
    pointer(a, 'pointerdown');
    expect(mocks.navigate).toHaveBeenCalled();
    expect(mocks.prefetch).not.toHaveBeenCalled();
  });

  it('resolves data-prefetch-href on a button', async () => {
    const button = document.createElement('button');
    button.dataset.prefetchHref = '/account/settings';
    document.body.append(button);
    pointer(button, 'pointerover');
    await vi.advanceTimersByTimeAsync(200);
    expect(mocks.prefetch).toHaveBeenCalledExactlyOnceWith('/account/settings', expect.anything());
  });

  it('ignores non-primary and modified pointerdown', () => {
    const a = link();
    pointer(a, 'pointerdown', { button: 1 });
    pointer(a, 'pointerdown', { metaKey: true });
    expect(mocks.navigate).not.toHaveBeenCalled();
    expect(mocks.prefetch).not.toHaveBeenCalled();
  });

  it('cancels armed work at logout and removes listeners on uninstall', async () => {
    const a = link();
    pointer(a, 'pointerover');
    endUserCache('logout');
    await vi.advanceTimersByTimeAsync(200);
    pointer(a, 'pointerdown');
    expect(mocks.prefetch).not.toHaveBeenCalled();
    bindUserCache('navigation-test');
    uninstall();
    pointer(a, 'pointerdown');
    expect(mocks.prefetch).not.toHaveBeenCalled();
    expect(mocks.restore).toHaveBeenCalled();
    uninstall = () => {};
  });
});
