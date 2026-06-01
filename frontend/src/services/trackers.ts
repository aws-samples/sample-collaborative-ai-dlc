import { api } from './api';
import type { TrackerBinding } from './projects';

// Provider-agnostic tracker resources. The polymorphic shapes here mirror
// the backend's normalized DTOs (lambda/trackers/providers/*). GitHub-specific
// numeric issue numbers are stringified into resourceId.

export interface TrackerLabel {
  name: string;
  color?: string;
}

export interface TrackerIssue {
  resourceId: string;
  resourceUrl: string;
  resourceType: 'issue';
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: TrackerLabel[];
  author: { handle: string; avatarUrl?: string };
  createdAt: string;
  updatedAt: string;
}

export interface TrackerIssuePage {
  items: TrackerIssue[];
  page: number;
  perPage: number;
  hasNext: boolean;
  hasPrev: boolean;
  totalCount: number | null;
}

export interface TrackerComment {
  id: string;
  author: { handle: string; avatarUrl?: string };
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface TrackerConnection {
  provider: string;
  instance: string | null;
  connectedAt: string | null;
  scope: string | null;
}

export interface AddTrackerInput {
  provider: string;
  instance: string;
  externalProjectKey: string;
  displayName?: string;
}

const CACHE_TTL_MS = 60_000;

interface CacheEntry {
  expiresAt: number;
  page: TrackerIssuePage;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (
  projectId: string,
  bindingId: string,
  state: 'open' | 'closed',
  q: string | undefined,
  page: number,
  perPage: number,
) => `${projectId}/${bindingId}|${state}|${q ?? ''}|${page}|${perPage}`;

const cacheGet = (key: string): TrackerIssuePage | undefined => {
  const entry = cache.get(key);
  if (!entry) return undefined;
  if (entry.expiresAt < Date.now()) {
    cache.delete(key);
    return undefined;
  }
  return entry.page;
};

const cacheSet = (key: string, page: TrackerIssuePage) => {
  cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, page });
};

export interface IssuePageResult {
  items: TrackerIssue[];
  totalCount: number | null;
  done: boolean;
}

export const trackersService = {
  // Connection-level — across all providers
  listConnections: () => api.get<TrackerConnection[]>('/trackers'),
  disconnect: (provider: string, instance: string) =>
    api.delete(`/trackers/${provider}/${instance}`),

  // Project-binding lifecycle
  listForProject: (projectId: string) =>
    api.get<TrackerBinding[]>(`/projects/${projectId}/trackers`),
  addToProject: (projectId: string, input: AddTrackerInput) =>
    api.post<TrackerBinding>(`/projects/${projectId}/trackers`, input),
  removeFromProject: (projectId: string, bindingId: string) =>
    api.delete(`/projects/${projectId}/trackers/${bindingId}`),

  // Resources scoped to a binding
  async listIssues(
    projectId: string,
    bindingId: string,
    state: 'open' | 'closed' = 'open',
    q?: string,
    page = 1,
    perPage = 30,
  ): Promise<TrackerIssuePage> {
    const key = cacheKey(projectId, bindingId, state, q, page, perPage);
    const hit = cacheGet(key);
    if (hit) return hit;

    const params = new URLSearchParams({ state, page: String(page), perPage: String(perPage) });
    if (q) params.set('q', q);
    const result = await api.get<TrackerIssuePage>(
      `/projects/${projectId}/trackers/${bindingId}/issues?${params.toString()}`,
    );
    cacheSet(key, result);
    return result;
  },

  async *listIssuePages(
    projectId: string,
    bindingId: string,
    state: 'open' | 'closed' = 'open',
    q?: string,
    perPage = 30,
    signal?: AbortSignal,
  ): AsyncGenerator<IssuePageResult> {
    let page = 1;
    let hasNext = true;
    while (hasNext) {
      if (signal?.aborted) return;
      const result = await this.listIssues(projectId, bindingId, state, q, page, perPage);
      hasNext = result.hasNext;
      page++;
      yield { items: result.items, totalCount: result.totalCount, done: !hasNext };
    }
  },

  invalidate(projectId: string, bindingId: string) {
    const prefix = `${projectId}/${bindingId}|`;
    for (const k of cache.keys()) {
      if (k.startsWith(prefix)) cache.delete(k);
    }
  },

  getIssue: (projectId: string, bindingId: string, resourceId: string) =>
    api.get<TrackerIssue>(`/projects/${projectId}/trackers/${bindingId}/issues/${resourceId}`),

  listComments: (projectId: string, bindingId: string, resourceId: string) =>
    api.get<TrackerComment[]>(
      `/projects/${projectId}/trackers/${bindingId}/issues/${resourceId}/comments`,
    ),
};
