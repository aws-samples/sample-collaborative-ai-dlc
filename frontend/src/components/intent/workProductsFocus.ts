// In-page navigation bus for the intent workbench's Work products panel.
// The graph-context popover (and the per-artifact items chip) navigate WITHOUT
// leaving the page: they emit a focus request; WorkProductsPanel expands the
// right accordion group, scrolls to the anchor, and flashes it. A tiny module
// event bus (not context) because emitters and the listener live in sibling
// trees and no render state is shared.

export interface WorkProductFocus {
  kind: 'artifact' | 'item';
  /** Node/artifact id — anchors are `artifact-<id>` / `item-<id>`. */
  id: string;
  /** For items: filter the derived section to one source artifact. */
  filterArtifactId?: string;
}

type Listener = (focus: WorkProductFocus) => void;

const listeners = new Set<Listener>();

export function onWorkProductFocus(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function focusWorkProduct(focus: WorkProductFocus): void {
  listeners.forEach((l) => l(focus));
}

// Scroll an anchored element into view and flash it. The target may live
// inside a just-expanded Radix accordion whose content mounts a render (and an
// expand animation) later — retry briefly until the anchor exists. Best-effort:
// still missing after the retries → no-op. Uses a hash anchor so the browser
// handles positioning natively.
export function scrollAndFlash(elementId: string, attempt = 0): void {
  const el = document.getElementById(elementId);
  if (!el) {
    if (attempt < 10) window.setTimeout(() => scrollAndFlash(elementId, attempt + 1), 80);
    return;
  }
  // Clear hash first so re-clicking the same target still scrolls.
  window.location.hash = '';
  window.location.hash = `#${elementId}`;
  el.classList.add('ring-2', 'ring-primary/60', 'transition-shadow', 'rounded-md');
  window.setTimeout(() => {
    el.classList.remove('ring-2', 'ring-primary/60');
  }, 1600);
}
