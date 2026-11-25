import { useCallback, useSyncExternalStore } from 'react';

// Per-user sidebar layout: the spaces pinned above the list and whether the
// "Pinned" and "Spaces" sections are collapsed. A module store (like useProjectSort) so every
// sidebar instance — inline column, drawer — reads one value; persisted in
// localStorage under the user's id so two accounts on one browser never share
// a layout. Pinned ids are kept in pin order; the sidebar sorts them like the
// other spaces.

export interface SidebarSpacesPrefs {
  pinned: readonly string[];
  pinnedCollapsed: boolean;
  spacesCollapsed: boolean;
}

type CollapsibleSection = 'pinnedCollapsed' | 'spacesCollapsed';

const KEY_PREFIX = 'aidlc.sidebar.spaces.';
const EMPTY: SidebarSpacesPrefs = { pinned: [], pinnedCollapsed: false, spacesCollapsed: false };

const storageKey = (userId: string) => `${KEY_PREFIX}${userId}`;

function load(userId: string): SidebarSpacesPrefs {
  try {
    const raw = localStorage.getItem(storageKey(userId));
    if (!raw) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return EMPTY;
    const { pinned, pinnedCollapsed, spacesCollapsed } = parsed as Partial<Record<string, unknown>>;
    return {
      pinned: Array.isArray(pinned)
        ? [...new Set(pinned.filter((id): id is string => typeof id === 'string'))]
        : [],
      pinnedCollapsed: pinnedCollapsed === true,
      spacesCollapsed: spacesCollapsed === true,
    };
  } catch {
    return EMPTY;
  }
}

const cache = new Map<string, SidebarSpacesPrefs>();
const listeners = new Set<() => void>();

function read(userId: string): SidebarSpacesPrefs {
  let prefs = cache.get(userId);
  if (!prefs) {
    prefs = load(userId);
    cache.set(userId, prefs);
  }
  return prefs;
}

function write(userId: string, next: SidebarSpacesPrefs) {
  cache.set(userId, next);
  try {
    localStorage.setItem(storageKey(userId), JSON.stringify(next));
  } catch {
    /* persistence is best-effort: the current visit still honors the choice */
  }
  listeners.forEach((fn) => fn());
}

export function setSpacePinned(userId: string, projectId: string, pinned: boolean) {
  const prefs = read(userId);
  const already = prefs.pinned.includes(projectId);
  if (pinned === already) return;
  write(userId, {
    ...prefs,
    pinned: pinned ? [...prefs.pinned, projectId] : prefs.pinned.filter((id) => id !== projectId),
  });
}

function setSectionCollapsed(userId: string, section: CollapsibleSection, collapsed: boolean) {
  const prefs = read(userId);
  if (prefs[section] === collapsed) return;
  write(userId, { ...prefs, [section]: collapsed });
}

export function setPinnedCollapsed(userId: string, collapsed: boolean) {
  setSectionCollapsed(userId, 'pinnedCollapsed', collapsed);
}

export function setSpacesCollapsed(userId: string, collapsed: boolean) {
  setSectionCollapsed(userId, 'spacesCollapsed', collapsed);
}

/** Test seam: forget what was read so the next render re-reads storage. */
export function resetSidebarSpacesCache() {
  cache.clear();
}

export interface SidebarSpaces extends SidebarSpacesPrefs {
  isPinned: (projectId: string) => boolean;
  setPinned: (projectId: string, pinned: boolean) => void;
  setPinnedCollapsed: (collapsed: boolean) => void;
  setSpacesCollapsed: (collapsed: boolean) => void;
}

const ANONYMOUS = 'anonymous';

export function useSidebarSpaces(userId: string | null | undefined): SidebarSpaces {
  const id = userId || ANONYMOUS;
  const subscribe = useCallback((onStoreChange: () => void) => {
    listeners.add(onStoreChange);
    // Another tab changed a layout: re-read it, so this tab shows it and its
    // next write builds on it instead of dropping the other tab's pins.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && !event.key.startsWith(KEY_PREFIX)) return;
      cache.clear();
      onStoreChange();
    };
    window.addEventListener('storage', onStorage);
    return () => {
      listeners.delete(onStoreChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);
  const prefs = useSyncExternalStore(subscribe, () => read(id));
  const isPinned = useCallback((projectId: string) => prefs.pinned.includes(projectId), [prefs]);
  const setPinned = useCallback(
    (projectId: string, pinned: boolean) => setSpacePinned(id, projectId, pinned),
    [id],
  );
  const collapsePinned = useCallback(
    (collapsed: boolean) => setPinnedCollapsed(id, collapsed),
    [id],
  );
  const collapseSpaces = useCallback(
    (collapsed: boolean) => setSpacesCollapsed(id, collapsed),
    [id],
  );
  return {
    ...prefs,
    isPinned,
    setPinned,
    setPinnedCollapsed: collapsePinned,
    setSpacesCollapsed: collapseSpaces,
  };
}
