import { useEffect, useCallback, useSyncExternalStore } from 'react';
import { projectsService, type Project } from '@/services/projects';
import { sprintsService, type Sprint } from '@/services/sprints';
import { intentsService, type Intent } from '@/services/intents';

const PROJECTS_TTL = 120_000;
const SPRINTS_TTL = 60_000;

export interface ProjectWithSprint {
  project: Project;
  latestSprint: Sprint | null;
  latestIntent: Intent | null;
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

async function fetchProjects(): Promise<ProjectWithSprint[]> {
  const projs = await projectsService.list();
  const results = await Promise.allSettled(
    projs.map(async (project): Promise<ProjectWithSprint> => {
      if (project.kind === 'v2') {
        try {
          const intents = await intentsService.list(project.id);
          return { project, latestSprint: null, latestIntent: pickIntent(intents) };
        } catch {
          return { project, latestSprint: null, latestIntent: null };
        }
      }
      const cached = sprintsCache.get(project.id);
      if (cached && !isStale(cached, SPRINTS_TTL)) {
        return { project, latestSprint: latestOf(cached.data), latestIntent: null };
      }
      try {
        const sprints = await sprintsService.list(project.id);
        sprintsCache.set(project.id, { data: sprints, fetchedAt: Date.now() });
        notifySprintListeners(project.id);
        return { project, latestSprint: latestOf(sprints), latestIntent: null };
      } catch {
        return { project, latestSprint: cached ? latestOf(cached.data) : null, latestIntent: null };
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
    } catch (err) {
      // Keep stale cache (if any); surface the failure to subscribers.
      projectsError = err instanceof Error ? err.message : 'Failed to load projects';
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
  throw new Error(projectsError ?? 'Failed to load projects');
}

function revalidateSprints(projectId: string, force = false): Promise<void> {
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
      sprintsCache.set(projectId, { data: sprints, fetchedAt: Date.now() });
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

// One shared poll timer for all mounted useProjectsCache instances.
let pollTimer: ReturnType<typeof setInterval> | null = null;
let pollRefCount = 0;

function retainPolling() {
  pollRefCount++;
  if (!pollTimer) {
    pollTimer = setInterval(() => revalidateProjects(), PROJECTS_TTL);
  }
}

function releasePolling() {
  pollRefCount = Math.max(0, pollRefCount - 1);
  if (pollRefCount === 0 && pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
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
