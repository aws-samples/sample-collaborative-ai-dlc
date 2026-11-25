import { useCallback, useSyncExternalStore } from 'react';
import { intentAttention } from '@/lib/sprintStatus';

// Shared project-sort selection: the Dashboard sort control and the sidebar
// project list subscribe to the same module-level store, so changing the sort
// in one place re-orders both immediately. Persisted to localStorage.

export type ProjectSort = 'attention' | 'activity' | 'created' | 'name';

export const PROJECT_SORT_LABELS: Record<ProjectSort, string> = {
  attention: 'Needs attention first',
  activity: 'Last activity',
  created: 'Recently created',
  name: 'Name (A–Z)',
};

const STORAGE_KEY = 'aidlc.projectSort';
const DEFAULT_SORT: ProjectSort = 'attention';

function loadStoredSort(): ProjectSort {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === 'created' || v === 'name' || v === 'activity' ? v : DEFAULT_SORT;
  } catch {
    return DEFAULT_SORT;
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

// "Needs attention" rank, identical to the Space page's intent order: an
// outstanding human decision or resume (0), then a failure (1), then the rest (2).
// Built on `intentAttention` so both pages share one rule.
export const NO_ATTENTION_RANK = 2;

export function intentAttentionRank(intent: Parameters<typeof intentAttention>[0]): 0 | 1 | 2 {
  const attention = intentAttention(intent);
  return attention === null ? NO_ATTENTION_RANK : attention === 'failed' ? 1 : 0;
}

export function projectAttentionRank(
  intents: readonly Parameters<typeof intentAttention>[0][],
): number {
  let rank: number = NO_ATTENTION_RANK;
  for (const intent of intents) {
    rank = Math.min(rank, intentAttentionRank(intent));
    if (rank === 0) break;
  }
  return rank;
}

// Minimal shape the comparator needs — both the Dashboard's enriched projects
// and the sidebar's derived entries satisfy it structurally. `attentionRank`
// is optional: a caller that does not know it sorts as if nothing were waiting.
export interface ProjectSortFields {
  name: string;
  createdAt: string;
  lastActivityAt: string | null;
  attentionRank?: number;
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
      case 'attention': {
        const rank =
          (a.attentionRank ?? NO_ATTENTION_RANK) - (b.attentionRank ?? NO_ATTENTION_RANK);
        if (rank) return rank;
        return time(b.lastActivityAt) - time(a.lastActivityAt);
      }
      case 'activity':
      default:
        return time(b.lastActivityAt) - time(a.lastActivityAt);
    }
  };
}
