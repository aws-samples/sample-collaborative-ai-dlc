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
  // Provider-specific subtype displayed as a chip in the issue list
  // (e.g. Jira's Epic / Story / Task / Bug / Sub-task). null when the
  // provider doesn't expose a per-issue type (GitHub Issues today).
  entityType?: string | null;
  entityIconUrl?: string | null;
  title: string;
  body: string | null;
  state: 'open' | 'closed';
  labels: TrackerLabel[];
  author: { handle: string; avatarUrl?: string };
  createdAt: string;
  updatedAt: string;
  // Jira: the issue's parent (Epic, Initiative, ...). Absent elsewhere.
  parent?: { resourceId: string; title: string; entityType: string | null } | null;
}

// A Jira project's issue type, as listed for the picker's type filter.
export interface TrackerIssueType {
  name: string;
  iconUrl: string | null;
  // 2 Initiative, 1 Epic, 0 Story/Task/Bug/Idea, -1 Sub-task.
  hierarchyLevel: number;
  subtask: boolean;
}

// Jira-only list filters.
export interface IssueFilters {
  // Comma-separated issue type names, e.g. "Epic,Story".
  type?: string;
  // Only the children (software) or linked items (Product Discovery) of this key.
  parent?: string;
  // Return the project's issue types with the first page.
  withTypes?: boolean;
}

export interface TrackerIssuePage {
  items: TrackerIssue[];
  page: number;
  perPage: number;
  hasNext: boolean;
  hasPrev: boolean;
  totalCount: number | null;
  // Opaque cursor used by providers that require token-based pagination
  // (Jira Cloud since Atlassian's CHANGE-2046 deprecated `startAt`/`total`).
  // Page-number providers like GitHub leave this null.
  nextPageToken?: string | null;
  // First page only, when requested with withTypes.
  issueTypes?: TrackerIssueType[];
  // software, business, service_desk or product_discovery.
  projectTypeKey?: string | null;
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

// Provider-agnostic shape returned by /trackers/external-projects/{p}/{i}.
// Today only jira-cloud implements it (Phase 3); github-issues uses
// free-form repo input rather than a picker.
export interface ExternalProject {
  key: string;
  name: string;
  displayKey?: string;
  // Jira: software, business, service_desk or product_discovery.
  projectTypeKey?: string;
}

// Operator-side OAuth-app config status, exposed by `GET /trackers/providers`.
// Drives the Admin "Tracker OAuth Apps" form and the project-level Connect-
// button gating: when a provider isn't `configured`, the operator hasn't
// populated the Secrets-Manager slot yet, so the user-facing OAuth flow
// can't run.
export interface TrackerProviderStatus {
  id: string;
  label: string;
  instances: string[];
  configured: boolean;
}

// Multi-site Jira callback payload — when the user has access to >1 Atlassian
// site, the callback returns the list and a signed `ticket` to finalize with.
export interface JiraPendingChoice {
  ticket: string;
  resources: { cloudId: string; name: string; host: string | null; url: string }[];
}

export interface JiraCallbackResult {
  success?: boolean;
  pendingChoice?: JiraPendingChoice;
  error?: string;
}

const CACHE_TTL_MS = 60_000;

// 'all' and the issue-type filter are honoured by Jira Cloud only.
export type IssueStateFilter = 'open' | 'closed' | 'all';

interface CacheEntry {
  expiresAt: number;
  page: TrackerIssuePage;
}

const cache = new Map<string, CacheEntry>();

const cacheKey = (
  projectId: string,
  bindingId: string,
  state: IssueStateFilter,
  q: string | undefined,
  page: number,
  perPage: number,
  pageToken?: string | null,
  filters: IssueFilters = {},
) =>
  `${projectId}/${bindingId}|${state}|${q ?? ''}|${page}|${perPage}|${pageToken ?? ''}|${filters.type ?? ''}|${filters.parent ?? ''}|${filters.withTypes ? 1 : 0}`;

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
  issueTypes?: TrackerIssueType[];
  projectTypeKey?: string | null;
}

export const trackersService = {
  // Connection-level — across all providers
  listConnections: () => api.get<TrackerConnection[]>('/trackers'),
  disconnect: (provider: string, instance: string) =>
    api.delete(`/trackers/${provider}/${instance}`),
  getAuthUrl: (provider: string) => api.get<{ url: string }>(`/trackers/auth/${provider}`),
  // Finalize a multi-site Jira flow. The OAuth callback page calls this
  // with the signed ticket from the previous step.
  finalizeJiraConnection: (ticket: string, cloudId: string) =>
    api.post<{ success: true }>('/trackers/connections/jira-cloud/cloud', { ticket, cloudId }),
  listExternalProjects: (provider: string, instance: string) =>
    api.get<ExternalProject[]>(`/trackers/external-projects/${provider}/${instance}`),

  // Operator OAuth-app config (Admin → Tracker OAuth Apps).
  listProviders: () => api.get<TrackerProviderStatus[]>('/trackers/providers'),
  setOAuthConfig: (providerId: string, clientId: string, clientSecret: string) =>
    api.put<{ success: true }>(`/trackers/providers/${providerId}/oauth-config`, {
      clientId,
      clientSecret,
    }),

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
    state: IssueStateFilter = 'open',
    q?: string,
    page = 1,
    perPage = 30,
    pageToken: string | null = null,
    filters: IssueFilters = {},
  ): Promise<TrackerIssuePage> {
    const key = cacheKey(projectId, bindingId, state, q, page, perPage, pageToken, filters);
    const hit = cacheGet(key);
    if (hit) return hit;

    const params = new URLSearchParams({ state, page: String(page), perPage: String(perPage) });
    if (q) params.set('q', q);
    if (pageToken) params.set('pageToken', pageToken);
    if (filters.type) params.set('type', filters.type);
    if (filters.parent) params.set('parent', filters.parent);
    if (filters.withTypes) params.set('withTypes', '1');
    const result = await api.get<TrackerIssuePage>(
      `/projects/${projectId}/trackers/${bindingId}/issues?${params.toString()}`,
    );
    cacheSet(key, result);
    return result;
  },

  async *listIssuePages(
    projectId: string,
    bindingId: string,
    state: IssueStateFilter = 'open',
    q?: string,
    perPage = 30,
    signal?: AbortSignal,
    filters: IssueFilters = {},
  ): AsyncGenerator<IssuePageResult> {
    let page = 1;
    let hasNext = true;
    let pageToken: string | null = null;
    // Page 1 puts an exact key match first; Jira's search may return it again later.
    const seen = new Set<string>();
    while (hasNext) {
      if (signal?.aborted) return;
      const result = await this.listIssues(
        projectId,
        bindingId,
        state,
        q,
        page,
        perPage,
        pageToken,
        filters,
      );
      hasNext = result.hasNext;
      pageToken = result.nextPageToken ?? null;
      page++;
      const items = result.items.filter((i) => !seen.has(i.resourceId));
      for (const i of items) seen.add(i.resourceId);
      yield {
        items,
        totalCount: result.totalCount,
        done: !hasNext,
        issueTypes: result.issueTypes,
        projectTypeKey: result.projectTypeKey,
      };
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
