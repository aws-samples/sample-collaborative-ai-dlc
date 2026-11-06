const RETRIES = 10;
const RETRY_MS = 80;
const FLASH_MS = 1600;

/**
 * Scrolls a rendered identifier definition into view and flashes it, retrying
 * briefly while the preview (or the overlay's portal) mounts. The container is
 * read afresh on each attempt, and the element is looked up inside it, because
 * the panel and the overlay can both render the same document. `done` runs once,
 * whether the element was found or not.
 */
export function scrollToReference(
  getContainer: () => HTMLElement | null,
  anchor: string,
  done: () => void,
  attempt = 0,
): void {
  const el = getContainer()?.querySelector<HTMLElement>(`[id="${CSS.escape(anchor)}"]`);
  if (!el) {
    if (attempt < RETRIES) {
      window.setTimeout(() => scrollToReference(getContainer, anchor, done, attempt + 1), RETRY_MS);
    } else {
      done();
    }
    return;
  }
  el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  el.classList.add('bg-primary/10', 'transition-colors');
  window.setTimeout(() => el.classList.remove('bg-primary/10'), FLASH_MS);
  done();
}
