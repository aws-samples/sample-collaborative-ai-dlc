import { useCallback, useSyncExternalStore } from 'react';

// Shared project-sort selection: the Dashboard sort control and the sidebar
// project list subscribe to the same module-level store, so changing the sort
// in one place re-orders both immediately. Persisted to localStorage.

export type ProjectSort = 'activity' | 'created' | 'name';

export const PROJECT_SORT_LABELS: Record<ProjectSort, string> = {
  activity: 'Last activity',
  created: 'Recently created',
  name: 'Name (A–Z)',
};

const STORAGE_KEY = 'aidlc.projectSort';

function loadStoredSort(): ProjectSort {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'created' || v === 'name' ? v : 'activity';
  } catch {
    return 'activity';
  }
}

let currentSort: ProjectSort = loadStoredSort();
const listeners = new Set<() => void>();

export function setProjectSort(value: ProjectSort) {
  currentSort = value;
  try {
    localStorage.setItem(STORAGE_KEY, value);
  } catch {
    /* persistence is best-effort */
  }
  listeners.forEach((fn) => fn());
}

export function useProjectSort(): [ProjectSort, (value: ProjectSort) => void] {
  const subscribe = useCallback((onStoreChange: () => void) => {
    listeners.add(onStoreChange);
    return () => {
      listeners.delete(onStoreChange);
    };
  }, []);
  const sort = useSyncExternalStore(subscribe, () => currentSort);
  return [sort, setProjectSort];
}

// Minimal shape the comparator needs — both the Dashboard's enriched projects
// and the sidebar's derived entries satisfy it structurally.
export interface ProjectSortFields {
  name: string;
  createdAt: string;
  lastActivityAt: string | null;
}

const time = (t: string | null | undefined) => (t ? new Date(t).getTime() : 0);

export function projectComparator(
  sort: ProjectSort,
): (a: ProjectSortFields, b: ProjectSortFields) => number {
  return (a, b) => {
    switch (sort) {
      case 'name':
        return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
      case 'created':
        return time(b.createdAt) - time(a.createdAt);
      case 'activity':
      default:
        return time(b.lastActivityAt) - time(a.lastActivityAt);
    }
  };
}
