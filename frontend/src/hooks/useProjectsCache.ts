import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { projectsService, type Project } from '@/services/projects';
import { sprintsService, type Sprint } from '@/services/sprints';
import { intentsService, type Intent } from '@/services/intents';
import { loadPersisted, persist } from '@/lib/persistentCache';

const PROJECTS_TTL = 30_000;
const SPRINTS_TTL = 60_000;

// Dashboard signals, aggregated across ALL of a project's intents (exact counts
// from the intent list we already fetch). `attention` is a subset of
// `inProgress` — they answer different questions:
//   inProgress = RUNNING + WAITING + CREATED + FAILED — work that isn't done.
//   attention  = WAITING + FAILED — a human is blocked, or a run broke.
export interface ProjectActivity {
  inProgress: number;
  attention: number;
}

export interface ProjectWithSprint {
  project: Project;
  latestSprint: Sprint | null;
  latestIntent: Intent | null;
  // Max updatedAt/completedAt/createdAt across ALL of the project's intents
  // (latestIntent alone can be a stale WAITING intent — see pickIntent).
  lastIntentActivityAt: string | null;
  // Cross-intent activity counts (v2 only; zeroed on sprint/v1 projects).
  activity: ProjectActivity;
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

let projectsCache: CacheEntry<ProjectWithSprint[]> | null = null;
let projectsFetching = false;
let projectsError: string | null = null;
const projectsListeners = new Set<() => void>();
let projectsVersion = 0;
let projectsHydrated = false;

const sprintsCache = new Map<string, CacheEntry<Sprint[]>>();
const sprintsFetching = new Set<string>();
// In-flight sprint fetch per project, plus at most one queued forced follow-up
// each. The follow-up lets a forced refresh await fresh (post-mutation) data
// instead of the in-flight response (see revalidateSprints).
const sprintsInflight = new Map<string, Promise<void>>();
const sprintsQueuedRefetch = new Map<string, Promise<void>>();
const sprintsListeners = new Map<string, Set<() => void>>();
// Per-project version counters so a sprint update for project A does not
// re-render components subscribed to project B's sprints.
const sprintsVersions = new Map<string, number>();

function notifyProjectListeners() {
  projectsVersion++;
  projectsListeners.forEach((fn) => fn());
}

function notifySprintListeners(projectId: string) {
  sprintsVersions.set(projectId, (sprintsVersions.get(projectId) ?? 0) + 1);
  sprintsListeners.get(projectId)?.forEach((fn) => fn());
}

function isStale(entry: { fetchedAt: number } | null, ttl: number): boolean {
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > ttl;
}

function latestOf(sprints: Sprint[]): Sprint | null {
  if (sprints.length === 0) return null;
  return sprints.reduce((latest, s) =>
    new Date(s.createdAt).getTime() > new Date(latest.createdAt).getTime() ? s : latest,
  );
}

function pickIntent(intents: Intent[]): Intent | null {
  if (intents.length === 0) return null;
  const running = intents.find((i) => i.status === 'RUNNING');
  if (running) return running;
  const waiting = intents.find((i) => i.status === 'WAITING');
  if (waiting) return waiting;
  return intents.reduce((latest, i) => {
    const lTime = latest.createdAt ? new Date(latest.createdAt).getTime() : 0;
    const iTime = i.createdAt ? new Date(i.createdAt).getTime() : 0;
    return iTime > lTime ? i : latest;
  });
}

// Best-known "last activity" instant for a project: the max of the project's
// own timestamps and the latest intent/sprint activity we already fetch for
// the dashboard. Returns null only when no timestamp is known at all.
export function projectLastActivityAt(p: ProjectWithSprint): string | null {
  const candidates = [
    p.project.updatedAt,
    p.project.createdAt,
    p.lastIntentActivityAt,
    p.latestSprint?.agentCompletedAt,
    p.latestSprint?.agentStartedAt,
    p.latestSprint?.createdAt,
  ].filter((t): t is string => !!t);
  if (candidates.length === 0) return null;
  return candidates.reduce((max, t) => (new Date(t).getTime() > new Date(max).getTime() ? t : max));
}

function maxIntentActivity(intents: Intent[]): string | null {
  let max: string | null = null;
  for (const i of intents) {
    for (const t of [i.updatedAt, i.completedAt, i.createdAt]) {
      if (t && (!max || new Date(t).getTime() > new Date(max).getTime())) max = t;
    }
  }
  return max;
}

export function deriveActivity(intents: Intent[]): ProjectActivity {
  let inProgress = 0;
  let attention = 0;
  for (const i of intents) {
    if (
      i.status === 'RUNNING' ||
      i.status === 'WAITING' ||
      i.status === 'CREATED' ||
      i.status === 'FAILED'
    ) {
      inProgress++;
    }
    if (i.status === 'WAITING' || i.status === 'FAILED') attention++;
  }
  return { inProgress, attention };
}

const NO_ACTIVITY: ProjectActivity = { inProgress: 0, attention: 0 };

async function fetchProjects(): Promise<ProjectWithSprint[]> {
  const projs = await projectsService.list();
  const results = await Promise.allSettled(
    projs.map(async (project): Promise<ProjectWithSprint> => {
      if (project.kind === 'v2') {
        try {
          const intents = await intentsService.list(project.id);
          return {
            project,
            latestSprint: null,
            latestIntent: pickIntent(intents),
            lastIntentActivityAt: maxIntentActivity(intents),
            activity: deriveActivity(intents),
          };
        } catch {
          return {
            project,
            latestSprint: null,
            latestIntent: null,
            lastIntentActivityAt: null,
            activity: NO_ACTIVITY,
          };
        }
      }
      const cached = sprintsCache.get(project.id);
      if (cached && !isStale(cached, SPRINTS_TTL)) {
        return {
          project,
          latestSprint: latestOf(cached.data),
          latestIntent: null,
          lastIntentActivityAt: null,
          activity: NO_ACTIVITY,
        };
      }
      try {
        const sprints = await sprintsService.list(project.id);
        sprintsCache.set(project.id, { data: sprints, fetchedAt: Date.now() });
        notifySprintListeners(project.id);
        return {
          project,
          latestSprint: latestOf(sprints),
          latestIntent: null,
          lastIntentActivityAt: null,
          activity: NO_ACTIVITY,
        };
      } catch {
        return {
          project,
          latestSprint: cached ? latestOf(cached.data) : null,
          latestIntent: null,
          lastIntentActivityAt: null,
          activity: NO_ACTIVITY,
        };
      }
    }),
  );
  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v): v is ProjectWithSprint => v !== null);
}

let projectsInflight: Promise<void> | null = null;
let projectsQueuedRefetch: Promise<void> | null = null;

function revalidateProjects(force = false): Promise<void> {
  if (!projectsHydrated) {
    projectsHydrated = true;
    const persisted = loadPersisted<ProjectWithSprint[]>('projects');
    if (persisted && !projectsCache) {
      projectsCache = persisted;
    }
  }
  if (projectsInflight) {
    if (!force) return projectsInflight;
    // Forced refresh (after create/delete/update) while a fetch is in flight:
    // the in-flight response may predate the mutation, so chain ONE follow-up
    // after it settles and return THAT promise — callers then await fresh data,
    // not the stale in-flight result. Concurrent forced callers coalesce onto
    // the same follow-up.
    if (!projectsQueuedRefetch) {
      projectsQueuedRefetch = projectsInflight
        .catch(() => {})
        .then(() => {
          projectsQueuedRefetch = null;
          return revalidateProjects(true);
        });
    }
    return projectsQueuedRefetch;
  }
  if (!force && !isStale(projectsCache, PROJECTS_TTL)) return Promise.resolve();
  projectsFetching = true;
  // Notify so subscribers see the loading transition (no flash of empty
  // content on cold load — they can render a skeleton instead).
  notifyProjectListeners();
  projectsInflight = (async () => {
    try {
      const data = await fetchProjects();
      projectsCache = { data, fetchedAt: Date.now() };
      projectsError = null;
      persist('projects', projectsCache);
    } catch (err) {
      // Keep stale cache (if any); surface the failure to subscribers.
      projectsError = err instanceof Error ? err.message : 'Failed to load spaces';
    } finally {
      projectsFetching = false;
      projectsInflight = null;
      notifyProjectListeners();
    }
  })();
  return projectsInflight;
}

export async function getProjectsWithSprints(): Promise<ProjectWithSprint[]> {
  if (projectsCache && !isStale(projectsCache, PROJECTS_TTL)) return projectsCache.data;
  await revalidateProjects();
  if (projectsCache) return projectsCache.data;
  throw new Error(projectsError ?? 'Failed to load spaces');
}

function revalidateSprints(projectId: string, force = false): Promise<void> {
  if (!sprintsCache.has(projectId)) {
    const persisted = loadPersisted<Sprint[]>(`sprints:${projectId}`);
    if (persisted) {
      sprintsCache.set(projectId, persisted);
    }
  }
  const inflight = sprintsInflight.get(projectId);
  if (inflight) {
    if (!force) return inflight;
    // Same race as revalidateProjects: chain one forced follow-up after the
    // in-flight fetch and return it, so forced callers await fresh data rather
    // than the in-flight response that may predate the mutation.
    let queued = sprintsQueuedRefetch.get(projectId);
    if (!queued) {
      queued = inflight
        .catch(() => {})
        .then(() => {
          sprintsQueuedRefetch.delete(projectId);
          return revalidateSprints(projectId, true);
        });
      sprintsQueuedRefetch.set(projectId, queued);
    }
    return queued;
  }
  if (!force && !isStale(sprintsCache.get(projectId) ?? null, SPRINTS_TTL))
    return Promise.resolve();
  const promise = (async () => {
    try {
      const sprints = await sprintsService.list(projectId);
      const entry = { data: sprints, fetchedAt: Date.now() };
      sprintsCache.set(projectId, entry);
      persist(`sprints:${projectId}`, entry);
      if (projectsCache) {
        const updated = projectsCache.data.map((p) =>
          p.project.id === projectId ? { ...p, latestSprint: latestOf(sprints) } : p,
        );
        projectsCache = { data: updated, fetchedAt: projectsCache.fetchedAt };
        notifyProjectListeners();
      }
    } catch {
      /* network failure — keep stale cache */
    } finally {
      sprintsFetching.delete(projectId);
      sprintsInflight.delete(projectId);
      notifySprintListeners(projectId);
    }
  })();
  sprintsFetching.add(projectId);
  sprintsInflight.set(projectId, promise);
  notifySprintListeners(projectId);
  return promise;
}

// One shared poll timer for all mounted useProjectsCache instances, plus
// focus/visibility listeners so the dashboard/sidebar catch up quickly when the
// user returns to the tab (there is no project-level WS channel — intent status
// changes are only broadcast per-intent, so this cache is poll/focus-driven).
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRefCount = 0;

// TTL-guarded revalidation: on focus/visibility we ask for fresh data, but
// isStale() short-circuits when the cache is still within PROJECTS_TTL, so
// rapid tab switches don't hammer the API.
const revalidateOnResume = () => {
  if (typeof document !== 'undefined' && document.visibilityState !== 'visible') return;
  revalidateProjects();
};

function retainPolling() {
  pollRefCount++;
  if (!pollTimer) {
    pollTimer = setInterval(() => revalidateProjects(), PROJECTS_TTL);
    if (typeof window !== 'undefined') {
      window.addEventListener('focus', revalidateOnResume);
      window.addEventListener('online', revalidateOnResume);
      document.addEventListener('visibilitychange', revalidateOnResume);
    }
  }
}

function releasePolling() {
  pollRefCount = Math.max(0, pollRefCount - 1);
  if (pollRefCount === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
    if (typeof window !== 'undefined') {
      window.removeEventListener('focus', revalidateOnResume);
      window.removeEventListener('online', revalidateOnResume);
      document.removeEventListener('visibilitychange', revalidateOnResume);
    }
  }
}

// Module-level (stable) mutation API — safe to use in effect dep arrays.
export function refreshProjects() {
  return revalidateProjects(true);
}

export function invalidateProjects() {
  projectsCache = null;
  projectsError = null;
  return revalidateProjects(true);
}

export function refreshProjectSprints(projectId: string) {
  return revalidateSprints(projectId, true);
}

export function useProjectsCache() {
  const subscribe = useCallback((onStoreChange: () => void) => {
    projectsListeners.add(onStoreChange);
    return () => {
      projectsListeners.delete(onStoreChange);
    };
  }, []);

  const getSnapshot = useCallback(() => projectsVersion, []);

  useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    // TTL-guarded: fresh cache → no fetch; failed/expired → retry.
    revalidateProjects();
    retainPolling();
    return () => releasePolling();
  }, []);

  return {
    projects: projectsCache?.data ?? [],
    loading: !projectsCache && projectsFetching,
    error: projectsCache ? null : projectsError,
    refresh: refreshProjects,
    invalidate: invalidateProjects,
  };
}

export function useProjectCache(projectId: string | null) {
  const { projects, loading, error } = useProjectsCache();
  const project = projectId
    ? (projects.find((p) => p.project.id === projectId)?.project ?? null)
    : null;
  return { project, loading, error };
}

export function useProjectSprintsCache(projectId: string | null) {
  const subscribe = useCallback(
    (onStoreChange: () => void) => {
      if (!projectId) return () => {};
      let listeners = sprintsListeners.get(projectId);
      if (!listeners) {
        listeners = new Set();
        sprintsListeners.set(projectId, listeners);
      }
      listeners.add(onStoreChange);
      return () => {
        listeners!.delete(onStoreChange);
      };
    },
    [projectId],
  );

  const getSnapshot = useCallback(
    () => (projectId ? (sprintsVersions.get(projectId) ?? 0) : 0),
    [projectId],
  );

  useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!projectId) return;
    revalidateSprints(projectId);
  }, [projectId]);

  const refresh = useCallback(() => {
    if (projectId) revalidateSprints(projectId, true);
  }, [projectId]);

  const cached = projectId ? sprintsCache.get(projectId) : null;
  const sorted: Sprint[] = cached?.data
    ? [...cached.data].toSorted(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
    : [];

  return {
    sprints: sorted,
    loading: projectId ? !cached && sprintsFetching.has(projectId) : false,
    refresh,
  };
}
