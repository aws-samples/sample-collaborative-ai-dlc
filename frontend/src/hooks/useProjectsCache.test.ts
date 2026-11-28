import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, renderHook, waitFor } from '@/test/query';
import { deriveActivity } from './useProjectsCache';
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';
import type { Intent, IntentStatus } from '@/services/intents';
import type { Project } from '@/services/projects';
import type { Sprint } from '@/services/sprints';

const cacheServiceMocks = vi.hoisted(() => ({
  listProjects: vi.fn<(options?: { signal?: AbortSignal }) => Promise<Project[]>>(() =>
    Promise.reject(new Error('unexpected projects fetch')),
  ),
  listSprints: vi.fn<() => Promise<Sprint[]>>(() =>
    Promise.reject(new Error('unexpected sprints fetch')),
  ),
  listIntents: vi.fn<
    (
      projectId: string,
      status?: IntentStatus,
      options?: { signal?: AbortSignal },
    ) => Promise<Intent[]>
  >(() => Promise.reject(new Error('unexpected intents fetch'))),
}));

vi.mock('@/services/projects', () => ({
  projectsService: {
    list: cacheServiceMocks.listProjects,
  },
}));
vi.mock('@/services/sprints', () => ({
  sprintsService: { list: cacheServiceMocks.listSprints },
}));
vi.mock('@/services/intents', () => ({
  intentsService: { list: cacheServiceMocks.listIntents },
}));

const intent = (status: IntentStatus): Intent => ({ status }) as Intent;

describe('deriveActivity — dashboard per-project counts', () => {
  it('counts nothing for an empty list', () => {
    expect(deriveActivity([])).toEqual({ inProgress: 0, attention: 0 });
  });

  it('inProgress = RUNNING + WAITING + CREATED + FAILED', () => {
    const intents = [intent('RUNNING'), intent('WAITING'), intent('CREATED'), intent('FAILED')];
    expect(deriveActivity(intents).inProgress).toBe(4);
  });

  it('does not mistake an automatic wait for a human decision', () => {
    const intents = [intent('RUNNING'), intent('WAITING'), intent('CREATED'), intent('FAILED')];
    expect(deriveActivity(intents).attention).toBe(1);
  });

  it('counts both a pending answer and a required resume as open work requiring attention', () => {
    const { inProgress, attention } = deriveActivity([
      { status: 'WAITING', pendingHumanTaskId: 'question' },
      { status: 'WAITING', resumeRequired: true },
    ]);
    expect(inProgress).toBe(2);
    expect(attention).toBe(2);
  });

  it('excludes terminal-done and abandoned statuses from both counts', () => {
    const intents = [intent('SUCCEEDED'), intent('CANCELLED'), intent('DRAFT')];
    expect(deriveActivity(intents)).toEqual({ inProgress: 0, attention: 0 });
  });

  it('aggregates across a mixed multi-intent project', () => {
    const intents = [
      intent('SUCCEEDED'), // ignored
      intent('RUNNING'), //    inProgress
      { ...intent('WAITING'), pendingHumanTaskId: 'question' }, // inProgress + attention
      intent('FAILED'), //     inProgress + attention
      intent('CANCELLED'), //  ignored
    ];
    expect(deriveActivity(intents)).toEqual({ inProgress: 3, attention: 2 });
  });
});

describe('useProjectsCache — sessionStorage hydration', () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    queryClient.clear();
    vi.resetModules();
    sessionStorage.clear();
    const { bindUserCache } = await import('@/lib/persistentCache');
    bindUserCache('fixture-user');
  });

  it('reuses a freshly loaded v2 space after reload only for the same signed-in user', async () => {
    const space: Project = {
      id: 'private-space',
      name: 'Private space',
      kind: 'v2',
      gitProvider: 'github',
      gitRepo: 'example/private',
      agentCli: 'codex',
      trackers: [],
      createdAt: '2026-01-01',
    };
    cacheServiceMocks.listProjects.mockResolvedValueOnce([space]).mockResolvedValueOnce([]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce([
      {
        id: 'pending',
        status: 'WAITING',
        title: 'Review brief',
        pendingHumanTaskId: 'q-1',
      } as Intent,
    ]);

    const loadPage = async (userId: string) => {
      queryClient.clear();
      vi.resetModules();
      const { bindUserCache } = await import('@/lib/persistentCache');
      bindUserCache(userId);
      const { getProjectsWithSprints } = await import('./useProjectsCache');
      return getProjectsWithSprints();
    };
    const first = await loadPage('fixture-user');
    expect(first[0].activity.attention).toBe(1);
    const sameUser = await loadPage('fixture-user');
    expect(sameUser[0].intents[0].id).toBe('pending');
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(1);
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(1);

    expect(await loadPage('different-user')).toEqual([]);
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(2);
  });

  it('re-renders subscribers that mounted before a fresh persisted cache is adopted', async () => {
    sessionStorage.setItem(
      'aidlc-cache:v2:fixture-user:projects',
      JSON.stringify({
        data: [
          {
            project: { id: 'p1', name: 'Space One' },
            latestSprint: null,
            latestIntent: null,
            lastIntentActivityAt: null,
            activity: { inProgress: 0, attention: 0 },
          },
        ],
        fetchedAt: Date.now(),
      }),
    );

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0].project.id).toBe('p1');
    expect(cacheServiceMocks.listProjects).not.toHaveBeenCalled();
  });

  it('re-renders sprint subscribers after adopting a fresh persisted cache', async () => {
    sessionStorage.setItem(
      'aidlc-cache:v2:fixture-user:sprints:p1',
      JSON.stringify({
        data: [{ id: 's1', name: 'Sprint One', createdAt: '2026-08-18T00:00:00.000Z' }],
        fetchedAt: Date.now(),
      }),
    );

    const { useProjectSprintsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectSprintsCache('p1'));

    await waitFor(() => expect(result.current.sprints).toHaveLength(1));
    expect(result.current.sprints[0]).toMatchObject({ id: 's1', name: 'Sprint One' } as Sprint);
    expect(cacheServiceMocks.listSprints).not.toHaveBeenCalled();
  });

  it('revalidates a legacy v2 cache entry that has no Intent list', async () => {
    const project: Project = {
      id: 'p1',
      name: 'Space One',
      kind: 'v2',
      gitProvider: 'github',
      gitRepo: 'https://github.com/example/repo',
      agentCli: 'codex',
      trackers: [],
      createdAt: '2026-09-22T07:00:00.000Z',
    };
    const intents = [
      { id: 'i-1', title: 'Waiting One', status: 'WAITING' },
      { id: 'i-2', title: 'Waiting Two', status: 'WAITING' },
    ] as Intent[];
    sessionStorage.setItem(
      'aidlc-cache:v2:fixture-user:projects',
      JSON.stringify({
        data: [
          {
            project,
            latestSprint: null,
            latestIntent: intents[0],
            lastIntentActivityAt: null,
            activity: { inProgress: 1, attention: 1 },
          },
        ],
        fetchedAt: Date.now(),
      }),
    );
    cacheServiceMocks.listProjects.mockResolvedValueOnce([project]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce(intents);

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());

    await waitFor(() => expect(result.current.projects[0].intents).toHaveLength(2));
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledOnce();
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledWith('p1', undefined, {
      signal: expect.any(AbortSignal),
    });
  });
});

describe('useProjectsCache — v2 Intent lists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    vi.resetModules();
    sessionStorage.clear();
  });

  it('retains every fetched Intent as a sidebar-safe summary alongside latestIntent', async () => {
    const intents = [
      {
        id: 'i-1',
        projectId: 'p1',
        title: 'First waiting Intent',
        prompt: 'Large prompt that must not be copied into the project cache',
        status: 'WAITING',
        createdAt: '2026-09-22T10:00:00.000Z',
      },
      {
        id: 'i-2',
        projectId: 'p1',
        title: 'Second waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T09:00:00.000Z',
      },
      {
        id: 'i-3',
        projectId: 'p1',
        title: 'Third waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T08:00:00.000Z',
      },
    ] as Intent[];
    cacheServiceMocks.listProjects.mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'Space One',
        kind: 'v2',
        gitProvider: 'github',
        gitRepo: 'https://github.com/example/repo',
        agentCli: 'codex',
        trackers: [],
        createdAt: '2026-09-22T07:00:00.000Z',
      },
    ]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce(intents);

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());

    await waitFor(() => expect(result.current.projects).toHaveLength(1));
    expect(result.current.projects[0].latestIntent).toEqual({
      id: 'i-1',
      title: 'First waiting Intent',
      status: 'WAITING',
      createdAt: '2026-09-22T10:00:00.000Z',
      updatedAt: undefined,
      completedAt: undefined,
      scope: undefined,
      pendingHumanTaskId: null,
      resumeRequired: false,
    });
    expect(result.current.projects[0].intents).toEqual([
      {
        id: 'i-1',
        title: 'First waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T10:00:00.000Z',
        updatedAt: undefined,
        completedAt: undefined,
        scope: undefined,
        pendingHumanTaskId: null,
        resumeRequired: false,
      },
      {
        id: 'i-2',
        title: 'Second waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T09:00:00.000Z',
        updatedAt: undefined,
        completedAt: undefined,
        scope: undefined,
        pendingHumanTaskId: null,
        resumeRequired: false,
      },
      {
        id: 'i-3',
        title: 'Third waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T08:00:00.000Z',
        updatedAt: undefined,
        completedAt: undefined,
        scope: undefined,
        pendingHumanTaskId: null,
        resumeRequired: false,
      },
    ]);
  });

  it('persists only sidebar-safe intent summaries, never the original prompt or runtime snapshot', async () => {
    const project = {
      id: 'p1',
      name: 'Space One',
      kind: 'v2',
      gitProvider: 'github',
      gitRepo: 'https://github.com/example/repo',
      agentCli: 'codex',
      trackers: [],
      createdAt: '2026-09-22T07:00:00.000Z',
    } as Project;
    cacheServiceMocks.listProjects.mockResolvedValueOnce([project]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce([
      {
        id: 'i-1',
        title: 'Waiting',
        status: 'WAITING',
        prompt: 'private user request',
        environment: { secretLikeSnapshot: 'private environment value' },
        pendingHumanTaskId: 'human-task-1',
        resumeRequired: {
          humanTaskId: 'human-task-1',
          callbackId: 'private-callback-id',
          answeredAt: null,
        },
        createdAt: '2026-09-22T10:00:00.000Z',
      },
    ] as unknown as Intent[]);
    const { bindUserCache } = await import('@/lib/persistentCache');
    expect(bindUserCache('fixture-user')).toBe('bound');

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());
    await waitFor(() => expect(result.current.projects).toHaveLength(1));

    const persisted = sessionStorage.getItem('aidlc-cache:v2:fixture-user:projects');
    expect(persisted).toContain('Waiting');
    expect(persisted).not.toContain('private user request');
    expect(persisted).not.toContain('private environment value');
    expect(persisted).toContain('human-task-1');
    expect(persisted).not.toContain('private-callback-id');
  });

  it('limits concurrent space activity reads to six and preserves project order', async () => {
    const projects = Array.from({ length: 14 }, (_, index) => ({
      id: `p${index}`,
      name: `Space ${index}`,
      kind: 'v2',
      gitProvider: 'github',
      gitRepo: `https://github.com/example/repo-${index}`,
      agentCli: 'codex',
      trackers: [],
      createdAt: '2026-09-22T07:00:00.000Z',
    })) as Project[];
    cacheServiceMocks.listProjects.mockResolvedValueOnce(projects);

    let active = 0;
    let maxActive = 0;
    const resolvers = new Map<string, (value: Intent[]) => void>();
    cacheServiceMocks.listIntents.mockImplementation(
      (projectId: string) =>
        new Promise<Intent[]>((resolve) => {
          active++;
          maxActive = Math.max(maxActive, active);
          resolvers.set(projectId, (value) => {
            active--;
            resolve(value);
          });
        }),
    );

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());
    await waitFor(() => expect(resolvers.size).toBe(6));

    for (let batch = 0; batch < projects.length; batch += 6) {
      const ids = projects.slice(batch, batch + 6).map((project) => project.id);
      for (const id of ids) resolvers.get(id)?.([]);
      await waitFor(() => expect(resolvers.size).toBe(Math.min(batch + 12, projects.length)));
    }

    await waitFor(() => expect(result.current.projects).toHaveLength(projects.length));
    expect(maxActive).toBe(6);
    expect(result.current.projects.map(({ project }) => project.id)).toEqual(
      projects.map(({ id }) => id),
    );
  });
});

const v2Space = (id: string): Project => ({
  id,
  name: `Space ${id}`,
  kind: 'v2',
  gitProvider: 'github',
  gitRepo: `https://github.com/example/${id}`,
  agentCli: 'codex',
  trackers: [],
  createdAt: '2026-09-22T07:00:00.000Z',
});

const fullIntent = (id: string, status: IntentStatus, extra: Partial<Intent> = {}): Intent =>
  ({
    id,
    projectId: 'p1',
    title: `Intent ${id}`,
    prompt: `Full prompt of ${id}`,
    status,
    createdAt: '2026-09-22T10:00:00.000Z',
    ...extra,
  }) as Intent;

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('useProjectsCache — shared queryCache store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    vi.resetModules();
    sessionStorage.clear();
  });

  it('publishes the space list before its intent lists resolve, then fills activity in', async () => {
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1'), v2Space('p2')]);
    const lists = new Map<string, ReturnType<typeof deferred<Intent[]>>>();
    cacheServiceMocks.listIntents.mockImplementation((projectId) => {
      const pending = deferred<Intent[]>();
      lists.set(projectId, pending);
      return pending.promise;
    });

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());
    expect(result.current.loading).toBe(true);

    await waitFor(() => expect(result.current.projects).toHaveLength(2));
    expect(result.current.loading).toBe(false);
    expect(result.current.projects.map((p) => p.activityLoading)).toEqual([true, true]);

    await act(async () => lists.get('p2')!.resolve([fullIntent('i-9', 'RUNNING')]));
    await waitFor(() => expect(result.current.projects[1].activityLoading).toBe(false));
    expect(result.current.projects[1].activity).toEqual({ inProgress: 1, attention: 0 });
    expect(result.current.projects[0].activityLoading).toBe(true);

    await act(async () => lists.get('p1')!.resolve([]));
    await waitFor(() => expect(result.current.projects[0].activityLoading).toBe(false));
  });

  it('publishes a cold failure without waiting for a polling render', async () => {
    const request = deferred<Project[]>();
    cacheServiceMocks.listProjects.mockReturnValueOnce(request.promise);
    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());
    await waitFor(() => expect(cacheServiceMocks.listProjects).toHaveBeenCalledOnce());
    await act(async () => request.reject(new Error('directory unavailable')));
    await waitFor(() => expect(result.current.error).toBe('directory unavailable'));
    expect(result.current.loading).toBe(false);
  });

  it('preserves an in-flight list retry when the portfolio starts retaining its query', async () => {
    const request = deferred<Intent[]>();
    const intents = [fullIntent('i-1', 'RUNNING')];
    cacheServiceMocks.listIntents
      .mockReturnValueOnce(request.promise)
      .mockResolvedValueOnce(intents);
    const { useProjectsCache, projectIntentsQuery } = await import('./useProjectsCache');
    queryClient.setQueryData(qk.projects(), [v2Space('p1')]);
    const pending = queryClient.fetchQuery({
      ...projectIntentsQuery('p1'),
      retry: 1,
      retryDelay: 0,
    });
    const { result } = renderHook(() => useProjectsCache());

    await act(async () => {
      request.reject(new Error('temporary network failure'));
      await pending;
    });

    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(2);
    expect(result.current.projects[0].intents[0].id).toBe('i-1');
    expect(result.current.projects[0].activityError).toBe(false);
  });

  it('retains the displayed source queries beyond the inactive entry cap', async () => {
    const projects = Array.from({ length: 200 }, (_, i) => v2Space(`p${i}`));
    cacheServiceMocks.listProjects.mockResolvedValueOnce(projects);
    cacheServiceMocks.listIntents.mockResolvedValue([]);
    const { useProjectsCache } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());
    await waitFor(
      () => {
        expect(result.current.projects).toHaveLength(200);
        expect(result.current.projects.every((item) => !item.activityLoading)).toBe(true);
      },
      { timeout: 4_000 },
    );
    for (const queryKey of [qk.projects(), qk.projectIntents('p0'), qk.projectIntents('p199')])
      expect(queryClient.getQueryCache().find({ queryKey })?.getObserversCount()).toBeGreaterThan(
        0,
      );
    for (let i = 0; i < 151; i++) queryClient.setQueryData(['unused', i], i);
    expect(result.current.projects).toHaveLength(200);
    expect(queryClient.getQueryData(qk.projects())).toEqual(projects);
  });

  it.each([403, 404, 410])(
    'does not revive a denied preview (%i) on retry, eviction or reload',
    async (status) => {
      const { bindUserCache } = await import('@/lib/persistentCache');
      bindUserCache('revocation-test');
      cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1')]);
      cacheServiceMocks.listIntents.mockResolvedValueOnce([fullIntent('secret', 'WAITING')]);
      const first = await import('./useProjectsCache');
      await first.getProjectsWithSprints();
      queryClient.clear();
      vi.resetModules();
      (await import('@/lib/persistentCache')).bindUserCache('revocation-test');
      const owner = await import('./useProjectsCache');
      expect(owner.getCachedIntentSummary('p1', 'secret')?.title).toBe('Intent secret');
      cacheServiceMocks.listIntents.mockRejectedValueOnce(
        Object.assign(new Error('denied'), { status }),
      );
      const query = owner.projectIntentsQuery('p1');
      await expect(queryClient.fetchQuery(query)).rejects.toMatchObject({ status });
      expect(owner.getCachedIntentSummary('p1', 'secret')).toBeUndefined();
      const pending = deferred<Intent[]>();
      cacheServiceMocks.listIntents.mockReturnValueOnce(pending.promise);
      const retry = queryClient.fetchQuery(query).catch(() => undefined);
      expect(owner.getCachedIntentSummary('p1', 'secret')).toBeUndefined();
      queryClient.removeQueries({ queryKey: query.queryKey });
      await retry;
      pending.resolve([]);
      expect(owner.getCachedIntentSummary('p1', 'secret')).toBeUndefined();
      expect(sessionStorage.getItem('aidlc-cache:v2:revocation-test:projects')).not.toContain(
        'Intent secret',
      );
      queryClient.clear();
      vi.resetModules();
      (await import('@/lib/persistentCache')).bindUserCache('revocation-test');
      expect(
        (await import('./useProjectsCache')).getCachedIntentSummary('p1', 'secret'),
      ).toBeUndefined();
    },
  );

  it('stores the full Intent list under qk.projectIntents and derives summaries from it', async () => {
    const intents = [fullIntent('i-1', 'WAITING', { pendingHumanTaskId: 'q-1' })];
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1')]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce(intents);

    const { getProjectsWithSprints, getCachedIntentSummary } = await import('./useProjectsCache');
    const { queryClient } = await import('@/lib/queryClient');
    const { qk } = await import('@/lib/queryKeys');
    const [space] = await getProjectsWithSprints();

    expect(queryClient.getQueryState(qk.projectIntents('p1'))?.data).toBe(intents);
    expect(space.intents[0]).not.toHaveProperty('prompt');
    expect(space.activity).toEqual({ inProgress: 1, attention: 1 });
    expect(getCachedIntentSummary('p1', 'i-1')).toMatchObject({
      id: 'i-1',
      title: 'Intent i-1',
      status: 'WAITING',
    });
    expect(getCachedIntentSummary('p1', 'missing')).toBeUndefined();
  });

  it('lets the Space page read the shell-fetched list without a second request', async () => {
    const intents = [fullIntent('i-1', 'RUNNING')];
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1')]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce(intents);

    const { getProjectsWithSprints, useSpaceIntents } = await import('./useProjectsCache');
    await getProjectsWithSprints();
    const { result } = renderHook(() => useSpaceIntents('p1'));

    expect(result.current.intents).toBe(intents);
    expect(result.current.loading).toBe(false);
    expect(result.current.updatedAt).toEqual(expect.any(Number));
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(1);
  });

  it('keeps stable references when nothing changed', async () => {
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1')]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce([fullIntent('i-1', 'RUNNING')]);

    const { useProjectsCache } = await import('./useProjectsCache');
    const { result, rerender } = renderHook(() => useProjectsCache());
    await waitFor(() => expect(result.current.projects[0]?.activityLoading).toBe(false));
    const before = result.current.projects;
    rerender();
    expect(result.current.projects).toBe(before);
    expect(result.current.projects[0]).toBe(before[0]);
  });

  it('keeps the last list and flags activityError when a space read fails', async () => {
    cacheServiceMocks.listProjects.mockResolvedValue([v2Space('p1')]);
    cacheServiceMocks.listIntents
      .mockResolvedValueOnce([fullIntent('i-1', 'RUNNING')])
      .mockRejectedValueOnce(new Error('network down'));

    const { useProjectsCache, refreshProjects } = await import('./useProjectsCache');
    const { result } = renderHook(() => useProjectsCache());
    await waitFor(() => expect(result.current.projects[0]?.intents).toHaveLength(1));

    await act(async () => {
      await refreshProjects();
    });

    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(2);
    expect(result.current.projects[0].intents.map((i) => i.id)).toEqual(['i-1']);
    expect(result.current.projects[0].activity.inProgress).toBe(1);
    expect(result.current.projects[0].activityError).toBe(true);
  });

  it('flags activityError without inventing an empty fresh list when the first read fails', async () => {
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1')]);
    cacheServiceMocks.listIntents.mockRejectedValueOnce(new Error('network down'));

    const { getProjectsWithSprints } = await import('./useProjectsCache');
    const [space] = await getProjectsWithSprints();

    expect(space.activityError).toBe(true);
    expect(space.activityLoading).toBe(false);
  });

  it('persists the summary view only — no prompts and no unknown lists as empty', async () => {
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1'), v2Space('p2')]);
    cacheServiceMocks.listIntents.mockImplementation((projectId) =>
      projectId === 'p1'
        ? Promise.resolve([fullIntent('i-1', 'RUNNING')])
        : Promise.reject(new Error('network down')),
    );
    const { bindUserCache } = await import('@/lib/persistentCache');
    bindUserCache('fixture-user');

    const { getProjectsWithSprints } = await import('./useProjectsCache');
    await getProjectsWithSprints();

    const raw = sessionStorage.getItem('aidlc-cache:v2:fixture-user:projects')!;
    expect(raw).not.toContain('Full prompt');
    expect(raw).not.toContain('activityError');
    const persisted = JSON.parse(raw).data as Array<{ intents?: unknown[] }>;
    expect(persisted[0].intents).toHaveLength(1);
    expect(persisted[1]).not.toHaveProperty('intents');
  });

  it('revalidates after reload when the last activity refresh failed', async () => {
    cacheServiceMocks.listProjects.mockResolvedValue([v2Space('p1')]);
    cacheServiceMocks.listIntents
      .mockResolvedValueOnce([fullIntent('i-1', 'RUNNING')])
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce([fullIntent('i-1', 'SUCCEEDED')]);
    const loadPage = async () => {
      queryClient.clear();
      vi.resetModules();
      const { bindUserCache } = await import('@/lib/persistentCache');
      bindUserCache('fixture-user');
      return import('./useProjectsCache');
    };

    const first = await loadPage();
    await first.getProjectsWithSprints();
    await first.refreshProjects();
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(2);
    const persisted = JSON.parse(
      sessionStorage.getItem('aidlc-cache:v2:fixture-user:projects')!,
    ) as { data: Array<{ intents?: unknown[] }> };
    expect(persisted.data[0]).not.toHaveProperty('intents');

    const reloaded = await loadPage();
    const [space] = await reloaded.getProjectsWithSprints();
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(3);
    expect(space.latestIntent?.status).toBe('SUCCEEDED');
  });

  it('treats a persisted space list as only as fresh as its last successful read', async () => {
    const now = Date.now();
    sessionStorage.setItem(
      'aidlc-cache:v2:fixture-user:projects',
      JSON.stringify({
        data: [
          {
            project: v2Space('p1'),
            latestSprint: null,
            latestIntent: null,
            intents: [],
            lastIntentActivityAt: null,
            activity: { inProgress: 0, attention: 0 },
            listUpdatedAt: now - 5 * 60_000,
          },
        ],
        fetchedAt: now,
      }),
    );
    const { bindUserCache } = await import('@/lib/persistentCache');
    bindUserCache('fixture-user');
    cacheServiceMocks.listProjects.mockResolvedValueOnce([v2Space('p1')]);
    cacheServiceMocks.listIntents.mockResolvedValueOnce([fullIntent('i-1', 'RUNNING')]);

    const { getProjectsWithSprints } = await import('./useProjectsCache');
    const [space] = await getProjectsWithSprints();

    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(1);
    expect(space.activity.inProgress).toBe(1);
  });

  it('a forced refresh during an in-flight read resolves with post-mutation data', async () => {
    const stale = deferred<Project[]>();
    cacheServiceMocks.listProjects
      .mockReturnValueOnce(stale.promise)
      .mockResolvedValueOnce([v2Space('p1'), v2Space('p2')]);
    cacheServiceMocks.listIntents.mockResolvedValue([]);

    const { getProjectsWithSprints, invalidateProjects } = await import('./useProjectsCache');
    const first = getProjectsWithSprints();
    const forced = invalidateProjects();
    stale.resolve([v2Space('p1')]);
    await forced;

    expect((await getProjectsWithSprints()).map((p) => p.project.id)).toEqual(['p1', 'p2']);
    expect((await first).map((p) => p.project.id)).toEqual(['p1', 'p2']);
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(2);
  });
});

describe('useProjectsCache — visibility-aware polling', () => {
  let visibility: DocumentVisibilityState = 'visible';

  beforeEach(() => {
    vi.clearAllMocks();
    queryClient.clear();
    vi.resetModules();
    sessionStorage.clear();
    visibility = 'visible';
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      get: () => visibility,
    });
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    visibility = 'visible';
  });

  const setVisibility = (state: DocumentVisibilityState) => {
    visibility = state;
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  };

  it('polls once per 30 s for all consumers, pauses while hidden, refreshes once on return', async () => {
    cacheServiceMocks.listProjects.mockResolvedValue([v2Space('p1')]);
    cacheServiceMocks.listIntents.mockResolvedValue([]);

    const { useProjectsCache } = await import('./useProjectsCache');
    renderHook(() => useProjectsCache());
    renderHook(() => useProjectsCache());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(2);
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(2);

    act(() => setVisibility('hidden'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(90_000);
    });
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(2);

    await act(async () => {
      setVisibility('visible');
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(3);
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledTimes(3);
  });

  it('hands the poller to a remaining consumer when the first one unmounts', async () => {
    cacheServiceMocks.listProjects.mockResolvedValue([]);

    const { useProjectsCache } = await import('./useProjectsCache');
    const first = renderHook(() => useProjectsCache());
    renderHook(() => useProjectsCache());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    first.unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(30_000);
    });
    expect(cacheServiceMocks.listProjects).toHaveBeenCalledTimes(2);
  });
});
