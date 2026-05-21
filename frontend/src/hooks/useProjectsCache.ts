import { useState, useEffect, useCallback, useSyncExternalStore } from 'react';
import { projectsService, type Project } from '@/services/projects';
import { sprintsService, type Sprint } from '@/services/sprints';

const PROJECTS_TTL = 120_000;
const SPRINTS_TTL = 60_000;

export interface ProjectWithSprint {
  project: Project;
  latestSprint: Sprint | null;
}

interface CacheEntry<T> {
  data: T;
  fetchedAt: number;
}

let projectsCache: CacheEntry<ProjectWithSprint[]> | null = null;
let projectsFetching = false;
let projectsListeners = new Set<() => void>();
let projectsVersion = 0;

const sprintsCache = new Map<string, CacheEntry<Sprint[]>>();
const sprintsFetching = new Set<string>();
const sprintsListeners = new Map<string, Set<() => void>>();
let sprintsVersion = 0;

function notifyProjectListeners() {
  projectsVersion++;
  projectsListeners.forEach((fn) => fn());
}

function notifySprintListeners(projectId: string) {
  sprintsVersion++;
  sprintsListeners.get(projectId)?.forEach((fn) => fn());
}

function isStale(entry: { fetchedAt: number } | null, ttl: number): boolean {
  if (!entry) return true;
  return Date.now() - entry.fetchedAt > ttl;
}

async function fetchProjects(): Promise<ProjectWithSprint[]> {
  const projs = await projectsService.list();
  const results = await Promise.allSettled(
    projs.map(async (project): Promise<ProjectWithSprint> => {
      const cached = sprintsCache.get(project.id);
      if (cached && !isStale(cached, SPRINTS_TTL)) {
        const sorted = [...cached.data].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        return { project, latestSprint: sorted[0] ?? null };
      }
      try {
        const sprints = await sprintsService.list(project.id);
        sprintsCache.set(project.id, { data: sprints, fetchedAt: Date.now() });
        notifySprintListeners(project.id);
        const sorted = [...sprints].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        return { project, latestSprint: sorted[0] ?? null };
      } catch {
        return { project, latestSprint: cached?.data?.[0] ?? null };
      }
    }),
  );
  return results
    .map((r) => (r.status === 'fulfilled' ? r.value : null))
    .filter((v): v is ProjectWithSprint => v !== null);
}

async function revalidateProjects(force = false) {
  if (projectsFetching) return;
  if (!force && !isStale(projectsCache, PROJECTS_TTL)) return;
  projectsFetching = true;
  try {
    const data = await fetchProjects();
    projectsCache = { data, fetchedAt: Date.now() };
    notifyProjectListeners();
  } catch {
    /* network failure — keep stale cache */
  } finally {
    projectsFetching = false;
  }
}

async function revalidateSprints(projectId: string, force = false) {
  if (sprintsFetching.has(projectId)) return;
  if (!force && !isStale(sprintsCache.get(projectId) ?? null, SPRINTS_TTL)) return;
  sprintsFetching.add(projectId);
  try {
    const sprints = await sprintsService.list(projectId);
    sprintsCache.set(projectId, { data: sprints, fetchedAt: Date.now() });
    notifySprintListeners(projectId);
    if (projectsCache) {
      const updated = projectsCache.data.map((p) => {
        if (p.project.id !== projectId) return p;
        const sorted = [...sprints].sort(
          (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        return { ...p, latestSprint: sorted[0] ?? null };
      });
      projectsCache = { data: updated, fetchedAt: projectsCache.fetchedAt };
      notifyProjectListeners();
    }
  } catch {
    /* network failure — keep stale cache */
  } finally {
    sprintsFetching.delete(projectId);
  }
}

let initialFetchFired = false;

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
    if (!initialFetchFired) {
      initialFetchFired = true;
      revalidateProjects();
    }
    const timer = setInterval(() => revalidateProjects(), 120_000);
    return () => clearInterval(timer);
  }, []);

  return {
    projects: projectsCache?.data ?? [],
    loading: !projectsCache && projectsFetching,
    refresh: () => revalidateProjects(true),
    invalidate: () => {
      projectsCache = null;
      revalidateProjects(true);
    },
  };
}

export function useProjectCache(projectId: string | null) {
  const { projects, loading } = useProjectsCache();
  const project = projectId
    ? (projects.find((p) => p.project.id === projectId)?.project ?? null)
    : null;
  return { project, loading };
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

  const getSnapshot = useCallback(() => sprintsVersion, []);

  useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!projectId) return;
    revalidateSprints(projectId);
  }, [projectId]);

  const cached = projectId ? sprintsCache.get(projectId) : null;
  const sorted = cached?.data
    ? [...cached.data].sort(
        (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
      )
    : [];

  return {
    sprints: sorted,
    loading: projectId ? !cached && sprintsFetching.has(projectId) : false,
    refresh: () => {
      if (projectId) revalidateSprints(projectId, true);
    },
  };
}
