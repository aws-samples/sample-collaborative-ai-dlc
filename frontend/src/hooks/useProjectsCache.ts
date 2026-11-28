// Shell portfolio cache: the space list, each v2 space's full Intent list and
// each v1 space's sprints live in the query cache (one entry per request), and
// the ProjectWithSprint view consumers read is derived from those entries.
// - Progressive: the space list publishes as soon as GET /projects returns;
//   each space's activity fills in as its list resolves (6 reads at a time).
// - A failed per-space read keeps its last value and flags `activityError`.
// - sessionStorage keeps only the small summary view (lib/persistentCache) so
//   a reload paints instantly; it counts as fresh only within the original TTL.
// - One poller for every consumer: 30 s while visible, paused while hidden.
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { projectsService, type Project } from '@/services/projects';
import { sprintsService, type Sprint } from '@/services/sprints';
import { intentsService, type Intent } from '@/services/intents';
import {
  loadPersisted,
  onUserCacheBound,
  onUserCacheEnded,
  persist,
  removePersisted,
} from '@/lib/persistentCache';
import { intentAttention } from '@/lib/sprintStatus';
import { queryClient, querySessionOpen } from '@/lib/queryClient';
import {
  isCancelledError,
  notifyManager,
  QueriesObserver,
  queryOptions,
  useQuery,
  type QueryState,
  type QueryKey,
  type QueryObserverOptions,
} from '@tanstack/react-query';
import { qk } from '@/lib/queryKeys';

const PROJECTS_TTL = 30_000;
const SPRINTS_TTL = 60_000;
const POLL_INTERVAL = 30_000;
const MAX_CONCURRENT_READS = 6;

// Dashboard signals, aggregated across ALL of a project's intents (exact counts
// from the intent list we already fetch). `attention` is a subset of
// `inProgress` — they answer different questions:
//   inProgress = RUNNING + WAITING + CREATED + FAILED — work that isn't done.
//   attention  = an outstanding human decision, a required resume, or a failure.
export interface ProjectActivity {
  inProgress: number;
  attention: number;
}

export type ProjectIntentSummary = Pick<
  Intent,
  'id' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'completedAt' | 'scope'
> & {
  pendingHumanTaskId?: string | null;
  // Store only whether a resume is needed; the callback identifiers belong in
  // the intent detail payload, not the persistent sidebar cache.
  resumeRequired?: boolean;
};

export interface ProjectWithSprint {
  project: Project;
  latestSprint: Sprint | null;
  latestIntent: ProjectIntentSummary | null;
  // Sidebar-safe summaries for all v2 Intents. Avoid persisting full prompts
  // and runtime snapshots in sessionStorage; consumers sort these timestamps.
  intents: ProjectIntentSummary[];
  // Max updatedAt/completedAt/createdAt across ALL of the project's intents
  // (latestIntent alone can be a stale WAITING intent — see pickIntent).
  lastIntentActivityAt: string | null;
  // Cross-intent activity counts (v2 only; zeroed on sprint/v1 projects).
  activity: ProjectActivity;
  // The space's intent/sprint list has not been read yet (fields are placeholders).
  activityLoading?: boolean;
  // The last read of the space's list failed; the fields keep the last known value.
  activityError?: boolean;
}

type PersistedProjectWithSprint = Omit<
  ProjectWithSprint,
  'intents' | 'activityLoading' | 'activityError'
> & {
  // Absent on entries that predate the multi-Intent sidebar, and on spaces
  // whose list was unknown or whose last read failed: all revalidate on hydration.
  intents?: ProjectIntentSummary[];
  // When the space's list was last read successfully (0: never). Absent on
  // entries that predate it, which use the envelope's fetchedAt.
  listUpdatedAt?: number;
};

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

export function deriveActivity(
  intents: Array<Parameters<typeof intentAttention>[0]>,
): ProjectActivity {
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
    if (intentAttention(i)) attention++;
  }
  return { inProgress, attention };
}

const NO_ACTIVITY: ProjectActivity = { inProgress: 0, attention: 0 };

function intentSummary(
  intent: Pick<
    Intent,
    'id' | 'title' | 'status' | 'createdAt' | 'updatedAt' | 'completedAt' | 'scope'
  > & {
    pendingHumanTaskId?: string | null;
    resumeRequired?: Intent['resumeRequired'] | boolean;
  },
): ProjectIntentSummary {
  return {
    id: intent.id,
    title: intent.title,
    status: intent.status,
    createdAt: intent.createdAt,
    updatedAt: intent.updatedAt,
    completedAt: intent.completedAt,
    scope: intent.scope,
    pendingHumanTaskId: intent.pendingHumanTaskId ?? null,
    resumeRequired: Boolean(intent.resumeRequired),
  };
}

// v1 sprints are not part of the shared key registry (retired execution path).
const sprintsKey = (projectId: string) => ['project', projectId, 'sprints'] as const;

const projectsQuery = queryOptions({
  queryKey: qk.projects(),
  queryFn: ({ signal }) => projectsService.list({ signal }),
  staleTime: PROJECTS_TTL,
  gcTime: 5 * 60_000,
});

// The FULL list, so the Space page, sidebar and ⌘K can reuse it unchanged.
export { intentsQuery as projectIntentsQuery };
function intentsQuery(projectId: string) {
  return queryOptions({
    queryKey: qk.projectIntents(projectId),
    queryFn: ({ signal }) => intentsService.list(projectId, undefined, { signal }),
    staleTime: PROJECTS_TTL,
    gcTime: 5 * 60_000,
  });
}

function sprintsQuery(projectId: string) {
  return queryOptions({
    queryKey: sprintsKey(projectId),
    queryFn: ({ signal }) => sprintsService.list(projectId, { signal }),
    staleTime: SPRINTS_TTL,
    gcTime: 5 * 60_000,
  });
}

const denied = (error: unknown) =>
  [403, 404, 410].includes((error as { status?: number } | null)?.status ?? 0);

function usable<T>(snapshot: QueryState<T> | undefined): T | undefined {
  return querySessionOpen && !denied(snapshot?.error) ? snapshot?.data : undefined;
}

interface HydratedItem {
  item: ProjectWithSprint;
  hasList: boolean;
  listUpdatedAt: number;
}

interface HydratedPortfolio {
  projects: Project[];
  items: Map<string, HydratedItem>;
  fetchedAt: number;
}

let hydratedPortfolio: HydratedPortfolio | null = null;
let portfolioHydrated = false;
const hydratedSprints = new Map<string, { data: Sprint[]; fetchedAt: number }>();
const sprintsHydrated = new Set<string>();
let revocationCache: ReturnType<typeof queryClient.getQueryCache> | undefined;
let stopRevocations = () => {};

function discardHydrated(key: QueryKey): boolean {
  if (key[0] === 'projects') {
    hydratedPortfolio = null;
    portfolioHydrated = true;
    removePersisted('projects');
  } else if (
    key[0] === 'project' &&
    typeof key[1] === 'string' &&
    ['intents', 'sprints'].includes(String(key[2]))
  ) {
    const id = key[1];
    hydratedPortfolio?.items.delete(id);
    if (hydratedPortfolio)
      hydratedPortfolio.projects = hydratedPortfolio.projects.filter(
        (project) => project.id !== id,
      );
    hydratedSprints.delete(id);
    sprintsHydrated.add(id);
    removePersisted(`sprints:${id}`);
    const saved = loadPersisted<PersistedProjectWithSprint[]>('projects');
    if (saved)
      persist('projects', {
        ...saved,
        data: saved.data.filter((entry) => entry.project.id !== id),
      });
  } else return false;
  itemMemo.clear();
  markDirty();
  return true;
}

function watchRevocations(): void {
  const cache = queryClient.getQueryCache();
  if (cache === revocationCache) return;
  stopRevocations();
  revocationCache = cache;
  stopRevocations = cache.subscribe(({ type, query }) => {
    if (type === 'updated' && denied(query.state.error) && discardHydrated(query.queryKey))
      notifyView();
  });
  for (const query of cache.getAll())
    if (denied(query.state.error)) discardHydrated(query.queryKey);
}

function normalizePersistedProject({
  listUpdatedAt: _listUpdatedAt,
  ...project
}: PersistedProjectWithSprint): ProjectWithSprint {
  return {
    ...project,
    activity: project.intents ? deriveActivity(project.intents) : project.activity,
    latestIntent: project.latestIntent ? intentSummary(project.latestIntent) : null,
    intents:
      project.intents?.map(intentSummary) ??
      (project.latestIntent ? [intentSummary(project.latestIntent)] : []),
  };
}

function hydratePortfolio(): void {
  watchRevocations();
  if (portfolioHydrated) return;
  portfolioHydrated = true;
  const persisted = loadPersisted<PersistedProjectWithSprint[]>('projects');
  if (!persisted || !Array.isArray(persisted.data)) return;
  const needsIntentListRefresh = persisted.data.some(
    (project) =>
      project.project.kind === 'v2' &&
      (!Array.isArray(project.intents) ||
        project.intents.some(
          (intent) => intent.status === 'WAITING' && intent.resumeRequired === undefined,
        )),
  );
  const items = new Map<string, HydratedItem>();
  // The portfolio is only as fresh as its oldest successfully read list.
  let fetchedAt = needsIntentListRefresh ? 0 : persisted.fetchedAt;
  for (const entry of persisted.data) {
    const listUpdatedAt = entry.listUpdatedAt ?? persisted.fetchedAt;
    fetchedAt = Math.min(fetchedAt, listUpdatedAt);
    items.set(entry.project.id, {
      item: normalizePersistedProject(entry),
      hasList: entry.project.kind !== 'v2' || Array.isArray(entry.intents),
      listUpdatedAt,
    });
  }
  hydratedPortfolio = {
    projects: persisted.data.map((entry) => entry.project),
    items,
    // Legacy, partial or failed entries keep rendering while a background
    // fetch fills the complete lists required by the multi-Intent sidebar.
    fetchedAt,
  };
  markDirty();
}

function hydrateSprints(projectId: string): void {
  watchRevocations();
  if (sprintsHydrated.has(projectId)) return;
  sprintsHydrated.add(projectId);
  const persisted = loadPersisted<Sprint[]>(`sprints:${projectId}`);
  if (persisted && Array.isArray(persisted.data)) hydratedSprints.set(projectId, persisted);
}

function sprintData(projectId: string): Sprint[] | undefined {
  if (!querySessionOpen) return undefined;
  const snapshot = queryClient.getQueryState<Sprint[]>(sprintsKey(projectId));
  if (denied(snapshot?.error)) return undefined;
  return usable(snapshot) ?? hydratedSprints.get(projectId)?.data;
}

interface PortfolioView {
  items: ProjectWithSprint[];
  hasData: boolean;
  loading: boolean;
  error: string | null;
}

interface ItemMemo {
  project: Project;
  list: unknown;
  fallback: ProjectWithSprint | undefined;
  loading: boolean;
  error: boolean;
  item: ProjectWithSprint;
}

const itemMemo = new Map<string, ItemMemo>();
let viewMemo: PortfolioView = { items: [], hasData: false, loading: true, error: null };
let dirty = true;
const viewListeners = new Set<() => void>();

function markDirty(): void {
  dirty = true;
}

// The query cache notifies synchronously, also while a component renders (a
// query created on first render); deferring keeps React from updating the
// sidebar or header in the middle of another component's render.
const notifyView = notifyManager.batchCalls((): void => {
  markDirty();
  for (const listener of Array.from(viewListeners)) listener();
});

function deriveItem(project: Project): ProjectWithSprint {
  const fallbackEntry = hydratedPortfolio?.items.get(project.id);
  let list: unknown;
  let error = false;
  let accessDenied = false;
  let snapshot: QueryState | undefined;
  if (project.kind === 'v2') {
    snapshot = queryClient.getQueryState<Intent[]>(qk.projectIntents(project.id));
    list = usable(snapshot);
  } else {
    snapshot = queryClient.getQueryState<Sprint[]>(sprintsKey(project.id));
    list = denied(snapshot?.error) ? undefined : sprintData(project.id);
  }
  if (snapshot && querySessionOpen && (snapshot.data !== undefined || snapshot.error)) {
    error = Boolean(snapshot.error);
  } else {
    error = failedLists.has(listKey(project));
  }
  accessDenied = denied(snapshot?.error);
  // A denied read must not fall back to the persisted (now revoked) view.
  const fallback = list === undefined && !accessDenied ? fallbackEntry?.item : undefined;
  const loading = list === undefined && !error && !(fallbackEntry?.hasList && fallback);
  const memo = itemMemo.get(project.id);
  if (
    memo &&
    memo.project === project &&
    memo.list === list &&
    memo.fallback === fallback &&
    memo.loading === loading &&
    memo.error === error
  ) {
    return memo.item;
  }
  let item: ProjectWithSprint;
  if (list !== undefined && project.kind === 'v2') {
    const intents = list as Intent[];
    const latestIntent = pickIntent(intents);
    item = {
      project,
      latestSprint: null,
      latestIntent: latestIntent ? intentSummary(latestIntent) : null,
      intents: intents.map(intentSummary),
      lastIntentActivityAt: maxIntentActivity(intents),
      activity: deriveActivity(intents),
      activityLoading: false,
      activityError: error,
    };
  } else if (list !== undefined) {
    item = {
      project,
      latestSprint: latestOf(list as Sprint[]),
      latestIntent: null,
      intents: [],
      lastIntentActivityAt: null,
      activity: NO_ACTIVITY,
      activityLoading: false,
      activityError: error,
    };
  } else if (fallback) {
    item = { ...fallback, project, activityLoading: loading, activityError: error };
  } else {
    item = {
      project,
      latestSprint: null,
      latestIntent: null,
      intents: [],
      lastIntentActivityAt: null,
      activity: NO_ACTIVITY,
      activityLoading: loading,
      activityError: error,
    };
  }
  itemMemo.set(project.id, { project, list, fallback, loading, error, item });
  return item;
}

function currentProjects(): Project[] | undefined {
  if (!querySessionOpen) return undefined;
  const snapshot = queryClient.getQueryState<Project[]>(qk.projects());
  const data = usable(snapshot);
  if (data) return data;
  if (denied(snapshot?.error)) return undefined;
  return hydratedPortfolio?.projects;
}

function getView(): PortfolioView {
  hydratePortfolio();
  // Without a bridge nothing marks the view dirty, so recompute (memoized items).
  if (!dirty && bridge) return viewMemo;
  dirty = false;
  const projects = currentProjects();
  const items = projects ? projects.map(deriveItem) : [];
  const hasData = projects !== undefined;
  const loading = !hasData && portfolioError === null && querySessionOpen;
  const error = hasData ? null : portfolioError;
  const same =
    viewMemo.hasData === hasData &&
    viewMemo.loading === loading &&
    viewMemo.error === error &&
    viewMemo.items.length === items.length &&
    viewMemo.items.every((item, index) => item === items[index]);
  if (!same) viewMemo = { items, hasData, loading, error };
  return viewMemo;
}

// While the view is observed, subscribe to the query-cache entries it reads so
// each commit (portfolio poll, Space page refetch, session clear) re-derives it.
let bridge: (() => void) | null = null;

function listKey(project: Project): string {
  return `${project.kind === 'v2' ? 'i' : 's'}:${project.id}`;
}

function invalidatedList(key: QueryKey): Project | undefined {
  if (key.length !== 3 || key[0] !== 'project' || typeof key[1] !== 'string') return undefined;
  const project = currentProjects()?.find(({ id }) => id === key[1]);
  if (!project) return undefined;
  return String(key[2]) === (project.kind === 'v2' ? 'intents' : 'sprints') ? project : undefined;
}

function openBridge(): void {
  if (bridge) return;
  const owner = new QueriesObserver(queryClient, []);
  const release = owner.subscribe(notifyView);
  let observed: Project[] | undefined | null = null;
  let syncing = false;
  const update = () => {
    if (syncing) return;
    const projects = currentProjects();
    if (projects !== observed) {
      observed = projects;
      syncing = true;
      owner.setQueries(
        [
          projectsQuery,
          ...(projects ?? []).map((project) =>
            project.kind === 'v2' ? intentsQuery(project.id) : sprintsQuery(project.id),
          ),
        ].map((query) => ({ ...query, enabled: false }) as QueryObserverOptions),
      );
      syncing = false;
    }
    notifyView();
  };
  const unsubscribe = queryClient.getQueryCache().subscribe((event) => {
    if (syncing) return;
    const { type, query } = event;
    // The bridge's observers are disabled (the portfolio reads on its own
    // schedule), so invalidating a list it shows — an intent write — does not
    // refetch it: re-read that list now instead of at the next poll.
    if (type === 'updated' && event.action.type === 'invalidate') {
      const shown = invalidatedList(query.queryKey);
      if (shown) void loadList(shown, 'refresh');
    }
    if (
      type === 'removed' &&
      (query.queryKey[0] === 'projects' ||
        (query.queryKey[0] === 'project' &&
          ['intents', 'sprints'].includes(String(query.queryKey[2]))))
    )
      observed = null;
    update();
  });
  bridge = () => {
    unsubscribe();
    release();
  };
  update();
}

function closeBridge(): void {
  if (!bridge) return;
  bridge();
  bridge = null;
  markDirty();
}

function subscribeView(listener: () => void): () => void {
  viewListeners.add(listener);
  openBridge();
  return () => {
    viewListeners.delete(listener);
    if (viewListeners.size === 0) closeBridge();
  };
}

function isListKnown(project: Project): boolean {
  if (project.kind !== 'v2') return true;
  if (usable(queryClient.getQueryState(qk.projectIntents(project.id))) !== undefined) return true;
  return hydratedPortfolio?.items.get(project.id)?.hasList ?? false;
}

function lastListSuccess(project: Project): number {
  const key = project.kind === 'v2' ? qk.projectIntents(project.id) : sprintsKey(project.id);
  const snapshot = queryClient.getQueryState(key);
  if (snapshot && usable(snapshot) !== undefined && snapshot.dataUpdatedAt > 0) {
    return snapshot.dataUpdatedAt;
  }
  if (project.kind !== 'v2') {
    const sprints = hydratedSprints.get(project.id);
    if (sprints) return sprints.fetchedAt;
  }
  return hydratedPortfolio?.items.get(project.id)?.listUpdatedAt ?? 0;
}

function persistView(): void {
  const snapshot = queryClient.getQueryState<Project[]>(qk.projects());
  const projects = usable(snapshot);
  if (!projects || !snapshot) return;
  const data: PersistedProjectWithSprint[] = projects.map((project) => {
    const {
      intents,
      activityLoading: _loading,
      activityError: error,
      ...rest
    } = deriveItem(project);
    const entry = { ...rest, listUpdatedAt: lastListSuccess(project) };
    // An unknown or failed list is persisted without `intents`, so a reload
    // revalidates it instead of trusting a placeholder or an outdated list.
    return isListKnown(project) && !error ? { ...entry, intents } : entry;
  });
  persist('projects', { data, fetchedAt: snapshot.dataUpdatedAt });
}

type Mode = 'stale' | 'refresh' | 'force';

let portfolioError: string | null = null;
// The cache drops an unobserved entry whose first read failed, so the failure
// is also remembered here (cleared by the next success).
const failedLists = new Set<string>();
let runSeq = 0;
let currentRun: { id: number; promise: Promise<void> } | null = null;

function fetchMode(mode: Mode) {
  if (mode !== 'stale') return { staleTime: 0 };
  return {};
}

function isPortfolioStale(): boolean {
  const snapshot = queryClient.getQueryState<Project[]>(qk.projects());
  if (usable(snapshot) !== undefined)
    return queryClient
      .getQueryCache()
      .find({ queryKey: qk.projects() })!
      .isStaleByTime(PROJECTS_TTL);
  if (!hydratedPortfolio) return true;
  return Date.now() - hydratedPortfolio.fetchedAt > PROJECTS_TTL;
}

function isCancellation(error: unknown): boolean {
  return isCancelledError(error);
}

async function loadList(project: Project, mode: Mode): Promise<void> {
  const key = listKey(project);
  try {
    if (project.kind === 'v2') {
      await queryClient.fetchQuery({ ...intentsQuery(project.id), ...fetchMode(mode) });
    } else {
      // Sprints keep their own 60 s TTL; only a forced refresh ignores it.
      await revalidateSprints(project.id, mode === 'force' ? 'refresh' : 'stale');
    }
    failedLists.delete(key);
  } catch (error) {
    if (!isCancellation(error)) failedLists.add(key);
    if (denied(error))
      discardHydrated(
        project.kind === 'v2' ? qk.projectIntents(project.id) : sprintsKey(project.id),
      );
  }
}

function revalidateProjects(mode: Mode): Promise<void> {
  hydratePortfolio();
  if (currentRun && mode !== 'force') return currentRun.promise;
  if (mode === 'stale' && !isPortfolioStale()) return Promise.resolve();
  if (mode === 'force')
    void queryClient.cancelQueries(
      {
        predicate: ({ queryKey }) =>
          queryKey[0] === 'projects' ||
          (queryKey[0] === 'project' && ['intents', 'sprints'].includes(String(queryKey[2]))),
      },
      { silent: true },
    );
  const id = ++runSeq;
  const superseded = () => currentRun?.id !== id;
  const promise = (async () => {
    try {
      // `force` supersedes an in-flight list read (its waiters adopt this one).
      const projects = await queryClient.fetchQuery({ ...projectsQuery, ...fetchMode(mode) });
      portfolioError = null;
      notifyView();
      let cursor = 0;
      const worker = async () => {
        while (cursor < projects.length && !superseded()) {
          await loadList(projects[cursor++], mode);
        }
      };
      await Promise.all(
        Array.from({ length: Math.min(MAX_CONCURRENT_READS, projects.length) }, worker),
      );
      if (!superseded()) persistView();
    } catch (error) {
      if (!isCancellation(error)) {
        if (denied(error)) discardHydrated(qk.projects());
        // Keep the last value (if any); surface the failure to subscribers.
        portfolioError = error instanceof Error ? error.message : 'Failed to load spaces';
      }
    }
    // A forced run replaced this one: its callers await the fresh data too.
    if (superseded() && currentRun) await currentRun.promise;
  })().finally(() => {
    if (currentRun?.id === id) currentRun = null;
    notifyView();
  });
  currentRun = { id, promise };
  notifyView();
  return promise;
}

export async function getProjectsWithSprints(): Promise<ProjectWithSprint[]> {
  if (!isPortfolioStale() && !currentRun) return getView().items;
  await revalidateProjects('stale');
  const view = getView();
  if (view.hasData) return view.items;
  throw new Error(portfolioError ?? 'Failed to load spaces');
}

function isSprintsStale(projectId: string): boolean {
  const snapshot = queryClient.getQueryState<Sprint[]>(sprintsKey(projectId));
  if (usable(snapshot) !== undefined)
    return queryClient
      .getQueryCache()
      .find({ queryKey: sprintsKey(projectId) })!
      .isStaleByTime(SPRINTS_TTL);
  const hydrated = hydratedSprints.get(projectId);
  return !hydrated || Date.now() - hydrated.fetchedAt > SPRINTS_TTL;
}

async function revalidateSprints(projectId: string, mode: Mode): Promise<void> {
  hydrateSprints(projectId);
  if (mode === 'stale' && !isSprintsStale(projectId)) return;
  if (mode === 'force')
    void queryClient.cancelQueries(
      { queryKey: sprintsKey(projectId), exact: true },
      { silent: true },
    );
  // With hydrated data but no cache entry, a stale read must still hit the network.
  const sprints = await queryClient
    .fetchQuery({ ...sprintsQuery(projectId), staleTime: 0 })
    .catch((error) => {
      if (denied(error)) discardHydrated(sprintsKey(projectId));
      throw error;
    });
  persist(`sprints:${projectId}`, { data: sprints, fetchedAt: Date.now() });
}

// There is no project-level WS channel (intent status changes are broadcast
// per intent), so the portfolio is poll- and focus-driven. Exactly one mounted
// consumer — the first — runs the poller; focus/online revalidate if stale.
const pollers: object[] = [];
const pollerListeners = new Set<() => void>();

function notifyPollers(): void {
  for (const listener of Array.from(pollerListeners)) listener();
}

function subscribePollers(listener: () => void): () => void {
  pollerListeners.add(listener);
  return () => {
    pollerListeners.delete(listener);
  };
}

const revalidateOnResume = () => {
  if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
  void revalidateProjects('stale');
};

function retainPoller(token: object): void {
  pollers.push(token);
  if (pollers.length === 1 && typeof window !== 'undefined') {
    window.addEventListener('focus', revalidateOnResume);
    window.addEventListener('online', revalidateOnResume);
  }
  notifyPollers();
}

function releasePoller(token: object): void {
  const index = pollers.indexOf(token);
  if (index === -1) return;
  pollers.splice(index, 1);
  if (pollers.length === 0 && typeof window !== 'undefined') {
    window.removeEventListener('focus', revalidateOnResume);
    window.removeEventListener('online', revalidateOnResume);
  }
  notifyPollers();
}

const pollPortfolio = () => revalidateProjects('refresh');

function resetHydration(): void {
  hydratedPortfolio = null;
  portfolioHydrated = false;
  hydratedSprints.clear();
  sprintsHydrated.clear();
  failedLists.clear();
  portfolioError = null;
  itemMemo.clear();
}

// The persisted copy goes with the session; a newly bound user hydrates anew.
onUserCacheEnded(() => {
  stopRevocations();
  revocationCache = undefined;
  resetHydration();
  currentRun = null;
  notifyView();
});
onUserCacheBound(() => {
  resetHydration();
  notifyView();
});

// Module-level (stable) mutation API — safe to use in effect dep arrays.
// Forced: supersedes in-flight reads, so callers await post-mutation data.
export function refreshProjects() {
  return revalidateProjects('force');
}

export function invalidateProjects() {
  portfolioError = null;
  hydratedPortfolio = null;
  // The forced run supersedes in-flight reads; invalidateQueries here would
  // restart them first and double the requests.
  return revalidateProjects('force');
}

export function refreshProjectSprints(projectId: string) {
  return revalidateSprints(projectId, 'force')
    .then(() => persistView())
    .catch(() => undefined);
}

export function useProjectsCache() {
  const view = useSyncExternalStore(subscribeView, getView);
  const [token] = useState(() => ({}));
  const isPoller = useSyncExternalStore(subscribePollers, () => pollers[0] === token);

  useEffect(() => {
    // TTL-guarded: fresh cache → no fetch; failed/expired → retry.
    void revalidateProjects('stale');
    retainPoller(token);
    return () => releasePoller(token);
  }, [token]);

  useQuery({
    queryKey: ['portfolio-refresh'],
    queryFn: async () => {
      await pollPortfolio();
      return getView().items;
    },
    initialData: () => getView().items,
    refetchOnMount: false,
    refetchOnWindowFocus: true,
    enabled: isPoller && querySessionOpen,
    staleTime: PROJECTS_TTL,
    refetchInterval: isPoller ? POLL_INTERVAL : false,
  });

  return {
    projects: view.items,
    loading: view.loading,
    error: view.error,
    refresh: refreshProjects,
    invalidate: invalidateProjects,
  };
}

export function useProjectCache(projectId: string | null) {
  const { projects, loading, error, refresh } = useProjectsCache();
  const project = projectId
    ? (projects.find((p) => p.project.id === projectId)?.project ?? null)
    : null;
  return { project, loading, error, refresh };
}

interface SprintsView {
  sprints: Sprint[];
  loading: boolean;
}

const NO_SPRINTS: SprintsView = { sprints: [], loading: false };
const sprintsViews = new Map<
  string,
  { data: Sprint[] | undefined; loading: boolean } & SprintsView
>();

function getSprintsView(projectId: string | null): SprintsView {
  if (!projectId) return NO_SPRINTS;
  hydrateSprints(projectId);
  const snapshot = queryClient.getQueryState<Sprint[]>(sprintsKey(projectId));
  const data = sprintData(projectId);
  const loading = data === undefined && !snapshot?.error && querySessionOpen;
  const memo = sprintsViews.get(projectId);
  if (memo && memo.data === data && memo.loading === loading) return memo;
  const sprints = data
    ? data.toSorted((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    : [];
  const next = { data, loading, sprints };
  sprintsViews.set(projectId, next);
  return next;
}

export function useProjectSprintsCache(projectId: string | null) {
  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      projectId
        ? queryClient.getQueryCache().subscribe(notifyManager.batchCalls(onStoreChange))
        : () => {},
    [projectId],
  );
  const getSnapshot = useCallback(() => getSprintsView(projectId), [projectId]);
  const view = useSyncExternalStore(subscribe, getSnapshot);

  useEffect(() => {
    if (!projectId) return;
    revalidateSprints(projectId, 'stale').catch(() => undefined);
  }, [projectId]);

  const refresh = useCallback(() => {
    if (projectId) void refreshProjectSprints(projectId);
  }, [projectId]);

  return { sprints: view.sprints, loading: view.loading, refresh };
}

/**
 * The full Intent list of one space, shared with the shell portfolio entry
 * (qk.projectIntents): no refetch while fresh, last value kept on failure.
 * `intents` is undefined while unknown — never an empty placeholder list.
 */
/** Summary of one intent from the cached space list, for header placeholders. */
export function getCachedIntentSummary(
  projectId: string,
  intentId: string,
): ProjectIntentSummary | undefined {
  if (!querySessionOpen) return undefined;
  const key = qk.projectIntents(projectId);
  const snapshot = queryClient.getQueryState<Intent[]>(key);
  if (denied(snapshot?.error)) {
    discardHydrated(key);
    return undefined;
  }
  const intents = usable(snapshot);
  const found = intents?.find((intent) => intent.id === intentId);
  if (found) return intentSummary(found);
  if (intents) return undefined;
  hydratePortfolio();
  return hydratedPortfolio?.items
    .get(projectId)
    ?.item.intents.find((intent) => intent.id === intentId);
}
