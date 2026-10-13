import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ApiError } from '@/services/api';
import {
  nativeIntentsService,
  type NativeIntent,
  type NativeIntentSummary,
} from '@/services/nativeIntents';
import { currentSessionEpoch, onSessionExpired, onSessionReset } from '@/services/sessionExpiry';
import { onCacheCleared } from '@/lib/persistentCache';
import type { NativeDiscoveredIntent } from '@/lib/intentDiscovery';

const TTL = 30_000;
const STATUS_READ_ERROR =
  'Some native execution statuses could not be refreshed. Entries remain available; affected statuses may be outdated.';
// Explicit paging bounds both memory and the cost of refreshing loaded pages.
export const MAX_NATIVE_PAGES = 40;
export interface NativeListing {
  items: NativeDiscoveredIntent[];
  nextCursor: string | null;
  loaded: boolean;
  loading: boolean;
  error: string | null;
  disabled: boolean;
  denied: boolean;
  pages: number;
  // Retain only the deletion guard if configuration is disabled after discovery.
  // Titles and other summaries are still removed on disabled/denied responses.
  hasKnownNativeIntents?: boolean;
  accessRevision?: number;
}
const EMPTY: NativeListing = {
  items: [],
  nextCursor: null,
  loaded: false,
  loading: false,
  error: null,
  disabled: false,
  denied: false,
  pages: 0,
};
interface Entry {
  state: NativeListing;
  fetchedAt: number;
  epoch: number;
  cursors: Set<string>;
  request?: Promise<void>;
  queuedRefresh?: Promise<void>;
}
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
let version = 0;
let accessRevision = 0;
const notify = () => {
  version++;
  listeners.forEach((listener) => listener());
};
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
};
const snapshot = () => version;

export const nativeAccessDenied = (error: unknown): error is ApiError =>
  error instanceof ApiError && [401, 403, 404].includes(error.status);
export const nativeListingDisabled = (error: unknown): boolean =>
  error instanceof ApiError &&
  ((error.status === 503 && error.body?.code === 'NATIVE_PREPARATION_DISABLED') ||
    (error.status === 403 && error.body?.code === 'NATIVE_PREPARATION_PROJECT_DISABLED'));

export function clearNativeIntents(projectId?: string, denied = false): void {
  if (projectId === undefined) entries.clear();
  else {
    entries.set(projectId, {
      state: {
        ...EMPTY,
        accessRevision: denied ? ++accessRevision : entries.get(projectId)?.state.accessRevision,
        hasKnownNativeIntents: entries.get(projectId)?.state.hasKnownNativeIntents ?? false,
        denied,
        error: denied ? 'Native intents are no longer accessible. Retry to check access.' : null,
      },
      fetchedAt: 0,
      epoch: currentSessionEpoch(),
      cursors: new Set(),
    });
  }
  notify();
}
onCacheCleared(() => clearNativeIntents());
onSessionExpired(() => clearNativeIntents());
onSessionReset(() => clearNativeIntents());

export function getNativeListing(projectId: string): NativeListing {
  const entry = entries.get(projectId);
  return entry?.epoch === currentSessionEpoch() ? entry.state : EMPTY;
}

export function useNativeListingVersion(): void {
  useSyncExternalStore(subscribe, snapshot);
}

export function nativeProjectDeleteReason(state: NativeListing | undefined): string | null {
  if (state?.items.length || state?.hasKnownNativeIntents)
    return 'Deleting a space with native intents is not available yet.';
  if (!state?.loaded || state.loading || state.error || state.denied || state.nextCursor) {
    return 'Space deletion requires a complete, accessible native intent list.';
  }
  return null;
}

function discoverySummary(intent: NativeIntent): NativeDiscoveredIntent {
  return {
    id: intent.id,
    projectId: intent.projectId,
    executionBackend: intent.executionBackend,
    title: intent.title,
    harness: intent.harness,
    status: intent.status,
    package: intent.package,
    ...(intent.failureCode !== undefined ? { failureCode: intent.failureCode } : {}),
    createdAt: intent.createdAt,
    updatedAt:
      intent.execution && Date.parse(intent.execution.updatedAt) > Date.parse(intent.updatedAt)
        ? intent.execution.updatedAt
        : intent.updatedAt,
    ...(intent.execution !== undefined
      ? {
          execution: intent.execution && {
            status: intent.execution.status,
            updatedAt: intent.execution.updatedAt,
            ...(intent.execution.revision !== undefined
              ? { revision: intent.execution.revision }
              : {}),
            ...(intent.execution.responsePending !== undefined
              ? { responsePending: intent.execution.responsePending }
              : {}),
            ...(intent.execution.turnSequence !== undefined
              ? { turnSequence: intent.execution.turnSequence }
              : {}),
          },
        }
      : {}),
  };
}

function latestSummary(
  previous: NativeDiscoveredIntent | undefined,
  next: NativeDiscoveredIntent,
): NativeDiscoveredIntent {
  const time = (item: NativeDiscoveredIntent) =>
    Math.max(Date.parse(item.updatedAt), Date.parse(item.execution?.updatedAt ?? item.updatedAt));
  const latest =
    previous &&
    ((previous.execution && !next.execution) ||
      (previous.execution?.revision !== undefined &&
        (next.execution?.revision === undefined ||
          next.execution.revision <= previous.execution.revision)) ||
      (next.execution?.revision === undefined && time(previous) > time(next)))
      ? previous
      : next;
  if (next.executionStatusUnavailable) return { ...latest, executionStatusUnavailable: true };
  // A successful read at the same revision confirms the retained execution.
  // Older reads still cannot clear uncertainty or replace newer accepted state.
  if (
    latest.executionStatusUnavailable &&
    next.execution?.revision !== undefined &&
    next.execution.revision === latest.execution?.revision
  ) {
    const { executionStatusUnavailable: _unavailable, ...confirmed } = latest;
    return confirmed;
  }
  return latest;
}

// Called only with the adapter's accepted current detail. Discovery remains the
// single list owner and does not retain another workspace state or authority.
export function updateNativeIntentSummary(intent: NativeIntent): void {
  const entry = entries.get(intent.projectId);
  if (!entry || entry.epoch !== currentSessionEpoch() || entry.state.denied || entry.state.disabled)
    return;
  const index = entry.state.items.findIndex((item) => item.id === intent.id);
  if (index < 0) return;
  const previous = entry.state.items[index];
  const next = latestSummary(previous, discoverySummary(intent));
  if (next === previous) return;
  const items = entry.state.items.map((item, itemIndex) => (itemIndex === index ? next : item));
  entry.state = {
    ...entry.state,
    items,
    error:
      entry.state.error === STATUS_READ_ERROR &&
      !items.some((item) => item.executionStatusUnavailable)
        ? null
        : entry.state.error,
  };
  notify();
}

async function hydrateExecution(
  projectId: string,
  summaries: NativeIntentSummary[],
  active: () => boolean,
): Promise<NativeDiscoveredIntent[]> {
  const items: NativeDiscoveredIntent[] = [...summaries];
  let nextIndex = 0;
  let denied = false;
  // The collection intentionally carries preparation metadata only. Reuse the
  // protected detail endpoint for READY rows, with at most four reads at once.
  const results = await Promise.allSettled(
    Array.from({ length: Math.min(4, items.length) }, async () => {
      while (!denied && active() && nextIndex < items.length) {
        const index = nextIndex++;
        if (items[index].status !== 'READY') continue;
        try {
          const detail = await nativeIntentsService.get(projectId, items[index].id);
          if (active()) items[index] = discoverySummary(detail);
        } catch (error) {
          if (nativeAccessDenied(error)) {
            denied = true;
            throw error;
          }
          // The collection authorized navigation independently of this optional
          // status read. Keep its summary and continue the other bounded reads.
          if (active()) items[index] = { ...items[index], executionStatusUnavailable: true };
        }
      }
    }),
  );
  // A late protected denial must not be hidden by an earlier transient failure.
  const failure =
    results.find((result) => result.status === 'rejected' && nativeAccessDenied(result.reason)) ??
    results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return items;
}

export async function refreshNativeIntents(
  projectId: string,
  mode: 'refresh' | 'more' = 'refresh',
  force = false,
): Promise<void> {
  let entry = entries.get(projectId);
  if (!entry || entry.epoch !== currentSessionEpoch()) {
    entry = { state: EMPTY, fetchedAt: 0, epoch: currentSessionEpoch(), cursors: new Set() };
    entries.set(projectId, entry);
  }
  if (entry.request) {
    if (!force || mode !== 'refresh') return entry.request;
    const pendingRequest = entry.request;
    const pendingOwner = entry;
    // A forced retry/pre-delete check must observe a request made after the
    // current one. Coalesce forced callers, but never revive a revoked owner.
    pendingOwner.queuedRefresh ??= pendingRequest.then(async () => {
      pendingOwner.queuedRefresh = undefined;
      if (entries.get(projectId) === pendingOwner && pendingOwner.epoch === currentSessionEpoch()) {
        await refreshNativeIntents(projectId, 'refresh', true);
      }
    });
    return pendingOwner.queuedRefresh;
  }
  if (mode === 'more' && (!entry.state.nextCursor || entry.state.pages >= MAX_NATIVE_PAGES)) return;
  if (mode === 'refresh' && !force && Date.now() - entry.fetchedAt < TTL) return;
  const owner = entry;
  const previous = owner.state;
  const active = () => entries.get(projectId) === owner && owner.epoch === currentSessionEpoch();
  owner.state = { ...previous, loading: true };
  notify();
  owner.request = (async () => {
    try {
      let cursor = mode === 'more' ? previous.nextCursor : null;
      const items = mode === 'more' ? [...previous.items] : [];
      const ids = new Set(items.map((item) => item.id));
      const cursors = mode === 'more' ? new Set(owner.cursors) : new Set<string>();
      let pages = mode === 'more' ? previous.pages : 0;
      const count = mode === 'more' ? 1 : Math.max(1, previous.pages);
      for (let page = 0; page < count; page++) {
        if (cursor !== null) cursors.add(cursor);
        const result = await nativeIntentsService.list(projectId, cursor);
        if (!active()) return;
        if (result.items.length) owner.state = { ...owner.state, hasKnownNativeIntents: true };
        const hydrated = await hydrateExecution(projectId, result.items, active);
        if (!active()) return;
        for (const item of hydrated) {
          if (ids.has(item.id))
            throw new Error('Native pagination returned a duplicate intent. Retry the list.');
          ids.add(item.id);
          items.push(item);
        }
        if (result.nextCursor !== null && cursors.has(result.nextCursor)) {
          throw new Error('Native pagination repeated a cursor. Retry the list.');
        }
        cursor = result.nextCursor;
        pages++;
        if (cursor === null) break;
      }
      if (!active()) return;
      owner.cursors = cursors;
      owner.fetchedAt = Date.now();
      const merged = items.map((item) =>
        latestSummary(
          owner.state.items.find((current) => current.id === item.id),
          item,
        ),
      );
      owner.state = {
        items: merged,
        nextCursor: cursor,
        pages,
        loaded: true,
        loading: false,
        error: merged.some((item) => item.executionStatusUnavailable) ? STATUS_READ_ERROR : null,
        disabled: false,
        denied: false,
        hasKnownNativeIntents: owner.state.hasKnownNativeIntents || items.length > 0,
        accessRevision: previous.accessRevision,
      };
    } catch (error) {
      if (!active()) return;
      if (nativeListingDisabled(error)) {
        owner.state = {
          ...EMPTY,
          loaded: true,
          disabled: true,
          hasKnownNativeIntents: owner.state.hasKnownNativeIntents,
          // The project-disabled 403 revokes loaded detail even though the
          // collection keeps its disabled presentation instead of an error.
          accessRevision: nativeAccessDenied(error) ? ++accessRevision : previous.accessRevision,
        };
        owner.fetchedAt = Date.now();
        owner.cursors.clear();
      } else if (nativeAccessDenied(error)) {
        // Replace the owner so any older request cannot restore denied data.
        clearNativeIntents(projectId, true);
      } else {
        owner.state = {
          ...owner.state,
          loading: false,
          error:
            'Native intents could not be refreshed. Previously loaded entries may be outdated.',
        };
      }
    } finally {
      owner.request = undefined;
      if (active()) notify();
    }
  })();
  return owner.request;
}

export function useNativeIntents(projectId: string) {
  useNativeListingVersion();
  const epoch = currentSessionEpoch();
  useEffect(() => {
    void refreshNativeIntents(projectId);
  }, [projectId, epoch]);
  const refresh = useCallback(() => refreshNativeIntents(projectId, 'refresh', true), [projectId]);
  const loadMore = useCallback(() => refreshNativeIntents(projectId, 'more'), [projectId]);
  return { ...getNativeListing(projectId), refresh, loadMore };
}
