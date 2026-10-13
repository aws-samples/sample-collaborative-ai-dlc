import { describe, it, expect, vi, beforeEach } from 'vitest';
import { act, renderHook, waitFor } from '@testing-library/react';
import { deriveActivity } from './useProjectsCache';
import type { Intent, IntentStatus } from '@/services/intents';
import type { Project } from '@/services/projects';
import type { Sprint } from '@/services/sprints';

const cacheServiceMocks = vi.hoisted(() => ({
  listProjects: vi.fn<() => Promise<Project[]>>(() =>
    Promise.reject(new Error('unexpected projects fetch')),
  ),
  listSprints: vi.fn<() => Promise<Sprint[]>>(() =>
    Promise.reject(new Error('unexpected sprints fetch')),
  ),
  listIntents: vi.fn<() => Promise<Intent[]>>(() =>
    Promise.reject(new Error('unexpected intents fetch')),
  ),
  listNative: vi.fn(),
  getNative: vi.fn(),
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
vi.mock('@/services/nativeIntents', () => ({
  nativeIntentsService: { list: cacheServiceMocks.listNative, get: cacheServiceMocks.getNative },
}));

// Only `status` matters to deriveActivity; keep fixtures minimal.
const intent = (status: IntentStatus): Intent => ({ status }) as Intent;

describe('deriveActivity — dashboard per-project counts', () => {
  it('counts nothing for an empty list', () => {
    expect(deriveActivity([])).toEqual({ inProgress: 0, attention: 0 });
  });

  it('inProgress = RUNNING + WAITING + CREATED + FAILED', () => {
    const intents = [intent('RUNNING'), intent('WAITING'), intent('CREATED'), intent('FAILED')];
    expect(deriveActivity(intents).inProgress).toBe(4);
  });

  it('attention = WAITING + FAILED only', () => {
    const intents = [intent('RUNNING'), intent('WAITING'), intent('CREATED'), intent('FAILED')];
    expect(deriveActivity(intents).attention).toBe(2);
  });

  it('attention is a subset of inProgress (WAITING counts in both)', () => {
    const { inProgress, attention } = deriveActivity([intent('WAITING'), intent('WAITING')]);
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
      intent('WAITING'), //    inProgress + attention
      intent('FAILED'), //     inProgress + attention
      intent('CANCELLED'), //  ignored
    ];
    expect(deriveActivity(intents)).toEqual({ inProgress: 3, attention: 2 });
  });
});

describe('useProjectsCache — sessionStorage hydration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.resetModules();
    sessionStorage.clear();
  });

  it('re-renders subscribers that mounted before a fresh persisted cache is adopted', async () => {
    sessionStorage.setItem(
      'aidlc-cache:v1:projects',
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
      'aidlc-cache:v1:sprints:p1',
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
      'aidlc-cache:v1:projects',
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
    expect(cacheServiceMocks.listIntents).toHaveBeenCalledWith('p1');
  });
});

describe('useProjectsCache — v2 Intent lists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
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
    expect(result.current.projects[0].latestIntent).toEqual(intents[0]);
    expect(result.current.projects[0].intents).toEqual([
      {
        id: 'i-1',
        title: 'First waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T10:00:00.000Z',
        updatedAt: undefined,
      },
      {
        id: 'i-2',
        title: 'Second waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T09:00:00.000Z',
        updatedAt: undefined,
      },
      {
        id: 'i-3',
        title: 'Third waiting Intent',
        status: 'WAITING',
        createdAt: '2026-09-22T08:00:00.000Z',
        updatedAt: undefined,
      },
    ]);
  });
});

describe('useProjectsCache — native discovery stays outside persisted platform previews', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    sessionStorage.clear();
    cacheServiceMocks.listIntents.mockResolvedValue([]);
    cacheServiceMocks.listNative.mockResolvedValue({ items: [], nextCursor: null });
    cacheServiceMocks.getNative.mockImplementation(async () => ({ ...native, prompt: '' }));
  });
  const native = {
    id: 'n1',
    projectId: 'p1',
    title: 'Private native title',
    executionBackend: 'native',
    status: 'READY',
    createdAt: '2026-09-29T07:00:00Z',
    updatedAt: '2026-09-29T07:00:00Z',
  };
  it.each(['projects', 'intents'])(
    'ignores a late prior-account %s 403 after the new native list loads',
    async (endpoint) => {
      cacheServiceMocks.listProjects.mockResolvedValue([
        { id: 'p1', name: 'Space', kind: 'v2' },
      ] as never);
      cacheServiceMocks.listNative.mockResolvedValue({ items: [native], nextCursor: null });
      const { getProjectsWithSprints, refreshProjects } = await import('./useProjectsCache');
      const { refreshNativeIntents, getNativeListing } = await import('./useNativeIntents');
      const { resetSessionExpiry } = await import('@/services/sessionExpiry');
      const { ApiError } = await import('@/services/api');
      await getProjectsWithSprints();
      let rejectOld!: (error: unknown) => void;
      const oldResponse = new Promise<never>((_resolve, reject) => {
        rejectOld = reject;
      });
      const target =
        endpoint === 'projects' ? cacheServiceMocks.listProjects : cacheServiceMocks.listIntents;
      target.mockReturnValueOnce(oldResponse);
      const oldWork = refreshProjects();
      await waitFor(() => expect(target).toHaveBeenCalledTimes(2));
      resetSessionExpiry();
      const current = { ...native, title: 'Account B native title' };
      cacheServiceMocks.listNative.mockResolvedValue({ items: [current], nextCursor: null });
      cacheServiceMocks.getNative.mockResolvedValue({ ...current, prompt: '' });
      await refreshNativeIntents('p1', 'refresh', true);
      expect(getNativeListing('p1').items[0].title).toBe(current.title);
      rejectOld(new ApiError(403, 'Account A denied'));
      await oldWork;
      expect(getNativeListing('p1').items[0].title).toBe(current.title);
      expect(getNativeListing('p1').denied).toBe(false);
    },
  );
  it('renders only fresh protected native summaries, without polluting the platform intent or persisted cache', async () => {
    cacheServiceMocks.listProjects.mockResolvedValueOnce([
      { id: 'p1', name: 'Space', kind: 'v2' },
    ] as never);
    cacheServiceMocks.listNative.mockResolvedValueOnce({ items: [native], nextCursor: null });
    const { useProjectsCache } = await import('./useProjectsCache');
    const hook = renderHook(() => useProjectsCache());
    await waitFor(() =>
      expect(hook.result.current.projects[0]?.nativeIntents?.items[0]).toEqual(native),
    );
    expect(hook.result.current.projects[0].latestIntent).toBeNull();
    expect(sessionStorage.getItem('aidlc-cache:v1:projects')).not.toContain('Private native title');
    expect(sessionStorage.getItem('aidlc-cache:v1:projects')).not.toContain('nativeIntents');
  });
  it('never renders a persisted native title before authorization or after a denied native load', async () => {
    sessionStorage.setItem(
      'aidlc-cache:v1:projects',
      JSON.stringify({
        data: [
          {
            project: { id: 'p1', name: 'Space', kind: 'v2' },
            latestIntent: null,
            intents: [],
            latestSprint: null,
            activity: { inProgress: 0, attention: 0 },
            nativeIntents: { items: [native], loaded: true },
          },
        ],
        fetchedAt: Date.now(),
      }),
    );
    const { ApiError } = await import('@/services/api');
    cacheServiceMocks.listNative.mockRejectedValueOnce(new ApiError(403, 'no membership'));
    const { useProjectsCache } = await import('./useProjectsCache');
    const hook = renderHook(() => useProjectsCache());
    expect(hook.result.current.projects[0]?.nativeIntents?.items ?? []).toEqual([]);
    await waitFor(() => expect(hook.result.current.projects[0]?.nativeIntents?.denied).toBe(true));
    expect(hook.result.current.projects[0].nativeIntents?.items).toEqual([]);
  });
  it('clears native summaries if the project list denies access on a later refresh', async () => {
    cacheServiceMocks.listProjects.mockResolvedValueOnce([
      { id: 'p1', name: 'Space', kind: 'v2' },
    ] as never);
    cacheServiceMocks.listNative.mockResolvedValueOnce({ items: [native], nextCursor: null });
    const { useProjectsCache } = await import('./useProjectsCache');
    const hook = renderHook(() => useProjectsCache());
    await waitFor(() =>
      expect(hook.result.current.projects[0]?.nativeIntents?.items).toHaveLength(1),
    );
    const { ApiError } = await import('@/services/api');
    cacheServiceMocks.listProjects.mockRejectedValueOnce(new ApiError(403, 'denied'));
    cacheServiceMocks.listNative.mockRejectedValue(new ApiError(403, 'denied'));
    await act(async () => {
      await hook.result.current.refresh();
    });
    expect(hook.result.current.projects[0]?.nativeIntents?.items).toEqual([]);
  });
});
