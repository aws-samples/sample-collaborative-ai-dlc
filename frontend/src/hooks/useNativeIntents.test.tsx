import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '@/services/api';
import { clearPersistedCache } from '@/lib/persistentCache';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import type { NativeExecution, NativeIntent, NativeIntentSummary } from '@/services/nativeIntents';
const { list, get } = vi.hoisted(() => ({ list: vi.fn(), get: vi.fn() }));
vi.mock('@/services/nativeIntents', () => ({ nativeIntentsService: { list, get } }));
import {
  clearNativeIntents,
  getNativeListing,
  MAX_NATIVE_PAGES,
  nativeProjectDeleteReason,
  refreshNativeIntents,
  updateNativeIntentSummary,
  useNativeIntents,
} from './useNativeIntents';

const item = (id: string, projectId = 'p1'): NativeIntentSummary => ({
  id,
  projectId,
  executionBackend: 'native',
  title: `Private ${id}`,
  harness: 'kiro',
  status: 'READY',
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'owner/repo', release: 'v2.9.0' },
  },
  createdAt: '2026-09-29T07:00:00Z',
  updatedAt: '2026-09-29T07:00:00Z',
});
const page = (id: string, nextCursor: string | null = null) => ({ items: [item(id)], nextCursor });
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  clearNativeIntents();
  vi.resetAllMocks();
  sessionStorage.clear();
  get.mockImplementation(async (projectId, id) => ({
    ...item(id, projectId),
    prompt: 'Private prompt',
  }));
});

describe('shared native discovery cache', () => {
  const execution = (status: NativeExecution['status'], revision = 1): NativeExecution => ({
    status,
    revision,
    attemptId: 'attempt-1',
    epoch: 0,
    startedAt: '2026-09-29T08:00:00Z',
    updatedAt: '2026-09-29T08:01:00Z',
    model: 'private model configuration',
    repository: { provider: 'github', repository: 'owner/private', branch: 'work', commit: null },
    publicationId: null,
    projectionStatus: null,
  });
  it('hydrates READY execution without retaining prompt, repository or reply authority', async () => {
    const detail = {
      ...item('running'),
      prompt: 'Private prompt',
      execution: execution('RUNNING'),
    };
    list.mockResolvedValueOnce({
      items: [
        item('running'),
        { ...item('draft'), status: 'DRAFT' },
        { ...item('preparing'), status: 'PREPARING' },
        { ...item('failed'), status: 'FAILED' },
      ],
      nextCursor: null,
    });
    get.mockResolvedValueOnce(detail);
    await refreshNativeIntents('p1');
    expect(get).toHaveBeenCalledExactlyOnceWith('p1', 'running');
    expect(getNativeListing('p1').items[0]).toEqual({
      ...item('running'),
      updatedAt: detail.execution.updatedAt,
      execution: { status: 'RUNNING', revision: 1, updatedAt: detail.execution.updatedAt },
    });
    expect(sessionStorage.length).toBe(0);
  });
  it('bounds detail reads to four concurrent requests and stops new reads after revocation', async () => {
    list.mockResolvedValueOnce({
      items: Array.from({ length: 7 }, (_, index) => item(String(index))),
      nextCursor: null,
    });
    const pending = deferred<NativeIntent>();
    get.mockReturnValue(pending.promise);
    const work = refreshNativeIntents('p1');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    clearNativeIntents('p1', true);
    pending.resolve({ ...item('late'), prompt: 'Private prompt' });
    await work;
    expect(get).toHaveBeenCalledTimes(4);
    expect(getNativeListing('p1')).toMatchObject({ items: [], denied: true });
  });
  it('preserves a newer accepted workspace status when older hydration settles or fails', async () => {
    list.mockResolvedValue(page('same'));
    get.mockResolvedValueOnce({ ...item('same'), prompt: '', execution: execution('RUNNING', 1) });
    await refreshNativeIntents('p1');
    const pending = deferred<NativeIntent>();
    get.mockReturnValueOnce(pending.promise);
    const refresh = refreshNativeIntents('p1', 'refresh', true);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    const current = { ...item('same'), prompt: '', execution: execution('AWAITING_USER', 3) };
    updateNativeIntentSummary(current);
    pending.resolve({ ...current, execution: execution('RUNNING', 2) });
    await refresh;
    expect(getNativeListing('p1').items[0].execution?.status).toBe('AWAITING_USER');
    const failed = deferred<NativeIntent>();
    get.mockReturnValueOnce(failed.promise);
    const failedRefresh = refreshNativeIntents('p1', 'refresh', true);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(3));
    updateNativeIntentSummary({ ...current, execution: execution('CANCELLED', 4) });
    failed.reject(new Error('Unavailable'));
    await failedRefresh;
    expect(getNativeListing('p1').items[0].execution?.status).toBe('CANCELLED');
    expect(getNativeListing('p1').error).toMatch(/may be outdated/);
  });
  it('does not replace admitted execution with a late preparation-only response', async () => {
    list.mockResolvedValue(page('same'));
    await refreshNativeIntents('p1');
    const pending = deferred<NativeIntent>();
    get.mockReturnValueOnce(pending.promise);
    const refresh = refreshNativeIntents('p1', 'refresh', true);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(2));
    updateNativeIntentSummary({ ...item('same'), prompt: '', execution: execution('DISPATCHING') });
    pending.resolve({ ...item('same'), prompt: '' });
    await refresh;
    expect(getNativeListing('p1').items[0].execution?.status).toBe('DISPATCHING');
  });
  it('does not hide a late protected denial behind an earlier transient hydration failure', async () => {
    list.mockResolvedValue({ items: [item('first'), item('second')], nextCursor: null });
    await refreshNativeIntents('p1');
    const first = deferred<NativeIntent>();
    const second = deferred<NativeIntent>();
    get.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    const refresh = refreshNativeIntents('p1', 'refresh', true);
    await waitFor(() => expect(get).toHaveBeenCalledTimes(4));
    first.reject(new Error('Temporary service failure'));
    await Promise.resolve();
    expect(getNativeListing('p1').loading).toBe(true);
    second.reject(new ApiError(403, 'Membership revoked'));
    await refresh;
    expect(getNativeListing('p1')).toMatchObject({ items: [], denied: true });
  });
  it('ignores a prior-account hydration denial after the new account has loaded', async () => {
    list.mockResolvedValue(page('same'));
    const pending = deferred<NativeIntent>();
    get.mockReturnValueOnce(pending.promise);
    const oldRefresh = refreshNativeIntents('p1');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    resetSessionExpiry();
    get.mockResolvedValueOnce({
      ...item('same'),
      title: 'New account title',
      prompt: '',
      execution: execution('RUNNING'),
    });
    await refreshNativeIntents('p1');
    pending.reject(new ApiError(403, 'Previous account denied'));
    await oldRefresh;
    expect(getNativeListing('p1')).toMatchObject({
      items: [{ title: 'New account title', execution: { status: 'RUNNING' } }],
      denied: false,
    });
  });
  it.each([401, 403, 404])(
    'clears titles when a detail hydration read is denied with %s',
    async (status) => {
      list.mockResolvedValue(page('same'));
      await refreshNativeIntents('p1');
      get.mockRejectedValueOnce(new ApiError(status, 'denied'));
      await refreshNativeIntents('p1', 'refresh', true);
      expect(getNativeListing('p1')).toMatchObject({ items: [], denied: true });
      updateNativeIntentSummary({ ...item('same'), prompt: '' });
      expect(getNativeListing('p1').items).toEqual([]);
    },
  );
  it('keeps a first hydration failure visible instead of claiming workspace readiness', async () => {
    list.mockResolvedValue(page('same'));
    get.mockRejectedValueOnce(new Error('Execution status unavailable'));
    await refreshNativeIntents('p1');
    expect(getNativeListing('p1')).toMatchObject({ items: [], loaded: false, loading: false });
    expect(getNativeListing('p1').error).toMatch(/could not be refreshed/);
    list.mockRejectedValueOnce(
      new ApiError(503, 'disabled', { code: 'NATIVE_PREPARATION_DISABLED' }),
    );
    await refreshNativeIntents('p1', 'refresh', true);
    expect(getNativeListing('p1').disabled).toBe(true);
    expect(nativeProjectDeleteReason(getNativeListing('p1'))).toMatch(/native intents/);
  });
  it('rejects hydration that returns after an account reset', async () => {
    list.mockResolvedValue(page('same'));
    const pending = deferred<NativeIntent>();
    get.mockReturnValueOnce(pending.promise);
    const refresh = refreshNativeIntents('p1');
    await waitFor(() => expect(get).toHaveBeenCalledTimes(1));
    resetSessionExpiry();
    pending.resolve({ ...item('same'), prompt: '', execution: execution('RUNNING') });
    await refresh;
    expect(getNativeListing('p1').items).toEqual([]);
  });
  it.each([
    [503, 'DISABLED'],
    [403, 'PROJECT_DISABLED'],
    [403, 'NATIVE_PREPARATION_DISABLED'],
    [503, 'NATIVE_PREPARATION_PROJECT_DISABLED'],
  ])('does not hide an unexpected disabled code/status pair %s/%s', async (status, code) => {
    list.mockRejectedValueOnce(new ApiError(Number(status), 'unavailable', { code }));
    await refreshNativeIntents('p1');
    expect(getNativeListing('p1').disabled).toBe(false);
    expect(getNativeListing('p1').error).toBeTruthy();
  });
  it('loads one bounded page and appends later pages, then refreshes all previously loaded pages', async () => {
    list.mockResolvedValueOnce(page('a', 'second')).mockResolvedValueOnce(page('b', 'third'));
    await refreshNativeIntents('p1');
    expect(list).toHaveBeenCalledTimes(1);
    await refreshNativeIntents('p1', 'more');
    expect(getNativeListing('p1').items.map((i) => i.id)).toEqual(['a', 'b']);
    list
      .mockResolvedValueOnce(page('a', 'new-second'))
      .mockResolvedValueOnce(page('b', 'new-third'));
    await refreshNativeIntents('p1', 'refresh', true);
    expect(list.mock.calls).toEqual([
      ['p1', null],
      ['p1', 'second'],
      ['p1', null],
      ['p1', 'new-second'],
    ]);
    expect(getNativeListing('p1')).toMatchObject({ nextCursor: 'new-third', pages: 2 });
    expect(getNativeListing('p1').items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(sessionStorage.length).toBe(0);
  });
  it('does not lose loaded pages when a later refresh page fails', async () => {
    list.mockResolvedValueOnce(page('a', 'second')).mockResolvedValueOnce(page('b', 'third'));
    await refreshNativeIntents('p1');
    await refreshNativeIntents('p1', 'more');
    list
      .mockResolvedValueOnce(page('new', 'new-second'))
      .mockRejectedValueOnce(new Error('offline'));
    await refreshNativeIntents('p1', 'refresh', true);
    expect(getNativeListing('p1').items.map((i) => i.id)).toEqual(['a', 'b']);
    expect(getNativeListing('p1').error).toMatch(/could not be refreshed/);
    list.mockResolvedValueOnce(page('a', 'second')).mockResolvedValueOnce(page('b', null));
    await refreshNativeIntents('p1', 'refresh', true);
    expect(getNativeListing('p1').error).toBeNull();
    expect(getNativeListing('p1').nextCursor).toBeNull();
  });
  it('deduplicates subscribers and coalesces forced refreshes after the in-flight request', async () => {
    const pending = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page('fresh'));
    const first = refreshNativeIntents('p1');
    const subscriber = refreshNativeIntents('p1');
    const second = refreshNativeIntents('p1', 'refresh', true);
    const third = refreshNativeIntents('p1', 'refresh', true);
    expect(list).toHaveBeenCalledTimes(1);
    pending.resolve(page('a'));
    await Promise.all([first, subscriber, second, third]);
    expect(list).toHaveBeenCalledTimes(2);
    expect(getNativeListing('p1').items).toEqual([item('fresh')]);
  });
  it('does not let a queued forced refresh revive an owner invalidated by denial', async () => {
    const pending = deferred<ReturnType<typeof page>>();
    list.mockReturnValue(pending.promise);
    const first = refreshNativeIntents('p1');
    const forced = refreshNativeIntents('p1', 'refresh', true);
    clearNativeIntents('p1', true);
    pending.resolve(page('secret'));
    await Promise.all([first, forced]);
    expect(getNativeListing('p1')).toMatchObject({ items: [], denied: true });
    expect(list).toHaveBeenCalledTimes(1);
  });
  it.each(['duplicate', 'cursor'])(
    'rejects cross-page %s without overwriting confirmed pages',
    async (kind) => {
      list
        .mockResolvedValueOnce(page('a', 'second'))
        .mockResolvedValueOnce(kind === 'duplicate' ? page('a', 'third') : page('b', 'second'));
      await refreshNativeIntents('p1');
      await refreshNativeIntents('p1', 'more');
      expect(getNativeListing('p1').items.map((i) => i.id)).toEqual(['a']);
      expect(getNativeListing('p1').error).toBeTruthy();
      expect(getNativeListing('p1').nextCursor).toBe('second');
    },
  );
  it('bounds explicit loading and refresh to 40 pages / 1000 records', async () => {
    list.mockImplementation(async (_project, cursor) => {
      const n = cursor ? Number(cursor) : 0;
      return page(String(n), String(n + 1));
    });
    await refreshNativeIntents('p1');
    for (let n = 0; n < MAX_NATIVE_PAGES + 3; n++) await refreshNativeIntents('p1', 'more');
    expect(list).toHaveBeenCalledTimes(MAX_NATIVE_PAGES);
    expect(getNativeListing('p1').pages).toBe(MAX_NATIVE_PAGES);
    expect(getNativeListing('p1').nextCursor).toBeTruthy();
    list.mockClear();
    await refreshNativeIntents('p1', 'refresh', true);
    expect(list).toHaveBeenCalledTimes(MAX_NATIVE_PAGES);
  });
  it.each([401, 403, 404])(
    'clears cached summaries after a typed %i and allows an explicit authorized retry',
    async (status) => {
      list
        .mockResolvedValueOnce(page('private'))
        .mockRejectedValueOnce(new ApiError(status, 'denied'));
      await refreshNativeIntents('p1');
      await refreshNativeIntents('p1', 'refresh', true);
      expect(getNativeListing('p1')).toMatchObject({ items: [], denied: true });
      list.mockResolvedValueOnce(page('new'));
      await refreshNativeIntents('p1', 'refresh', true);
      expect(getNativeListing('p1')).toMatchObject({ items: [item('new')], denied: false });
    },
  );
  it('keeps generic errors visible and preserves platform deletion for exact typed disabled states', async () => {
    list.mockRejectedValueOnce(new Error('DISABLED'));
    await refreshNativeIntents('p1');
    expect(getNativeListing('p1').error).toBeTruthy();
    list.mockRejectedValueOnce(new ApiError(503, 'off', { code: 'NATIVE_PREPARATION_DISABLED' }));
    await refreshNativeIntents('p1', 'refresh', true);
    expect(getNativeListing('p1')).toMatchObject({ items: [], disabled: true, error: null });
    expect(nativeProjectDeleteReason(getNativeListing('p1'))).toBeNull();
  });
  it.each([
    [503, 'NATIVE_PREPARATION_DISABLED'],
    [403, 'NATIVE_PREPARATION_PROJECT_DISABLED'],
  ] as const)(
    'preserves disabled listing/deletion behavior and the expected access revision for %s',
    async (status, code) => {
      list.mockRejectedValueOnce(new ApiError(status, 'off', { code }));
      await refreshNativeIntents('p1');
      const state = getNativeListing('p1');
      expect(state).toMatchObject({
        items: [],
        loaded: true,
        disabled: true,
        denied: false,
        error: null,
      });
      expect(nativeProjectDeleteReason(state)).toBeNull();
      if (status === 403) expect(state.accessRevision).toBeGreaterThan(0);
      else expect(state.accessRevision ?? 0).toBe(0);
    },
  );
  it('still blocks deletion for known native work after configuration is disabled', async () => {
    list
      .mockResolvedValueOnce(page('exists'))
      .mockRejectedValueOnce(
        new ApiError(403, 'off', { code: 'NATIVE_PREPARATION_PROJECT_DISABLED' }),
      );
    await refreshNativeIntents('p1');
    await refreshNativeIntents('p1', 'refresh', true);
    expect(getNativeListing('p1').items).toEqual([]);
    expect(getNativeListing('p1').disabled).toBe(true);
    expect(nativeProjectDeleteReason(getNativeListing('p1'))).toMatch(/native intents/);
  });
  it('cannot restore a late list response after a protected detail denial', async () => {
    const pending = deferred<ReturnType<typeof page>>();
    list.mockReturnValue(pending.promise);
    const work = refreshNativeIntents('p1');
    clearNativeIntents('p1', true);
    pending.resolve(page('old-secret'));
    await work;
    expect(getNativeListing('p1')).toMatchObject({ items: [], denied: true });
  });
  it('clears all native data on logout, including pending responses', async () => {
    list.mockResolvedValueOnce(page('secret'));
    await refreshNativeIntents('p1');
    const pending = deferred<ReturnType<typeof page>>();
    list.mockReturnValue(pending.promise);
    const work = refreshNativeIntents('p1', 'refresh', true);
    clearPersistedCache();
    pending.resolve(page('late-secret'));
    await work;
    expect(getNativeListing('p1').items).toEqual([]);
  });
  it('changes accounts without rendering old titles and rejects the previous account response', async () => {
    list.mockResolvedValueOnce(page('old-title'));
    const hook = renderHook(() => useNativeIntents('p1'));
    await waitFor(() => expect(hook.result.current.items[0]?.title).toBe('Private old-title'));
    const oldRequest = deferred<ReturnType<typeof page>>();
    const newRequest = deferred<ReturnType<typeof page>>();
    list.mockReturnValueOnce(oldRequest.promise).mockReturnValueOnce(newRequest.promise);
    let oldWork!: Promise<void>;
    act(() => {
      oldWork = hook.result.current.refresh();
    });
    act(() => resetSessionExpiry());
    expect(hook.result.current.items).toEqual([]);
    await act(async () => {
      oldRequest.resolve(page('late-secret'));
      await oldWork;
    });
    expect(hook.result.current.items).toEqual([]);
    await act(async () => {
      newRequest.reject(new ApiError(403, 'not a member'));
    });
    expect(hook.result.current.items).toEqual([]);
    expect(hook.result.current.denied).toBe(true);
  });
  it('does not reuse another project cache when the selected space changes', async () => {
    list.mockResolvedValueOnce(page('secret'));
    const hook = renderHook(({ projectId }) => useNativeIntents(projectId), {
      initialProps: { projectId: 'p1' },
    });
    await waitFor(() => expect(hook.result.current.items).toHaveLength(1));
    list.mockRejectedValueOnce(new ApiError(403, 'not a member'));
    hook.rerender({ projectId: 'p2' });
    expect(hook.result.current.items).toEqual([]);
    await waitFor(() => expect(hook.result.current.denied).toBe(true));
  });
  it('requires a complete, empty, freshly confirmed native list before space deletion', async () => {
    expect(nativeProjectDeleteReason(undefined)).toBeTruthy();
    list.mockResolvedValueOnce({ items: [], nextCursor: null });
    await refreshNativeIntents('p1');
    expect(nativeProjectDeleteReason(getNativeListing('p1'))).toBeNull();
    list.mockResolvedValueOnce(page('exists'));
    await refreshNativeIntents('p1', 'refresh', true);
    expect(nativeProjectDeleteReason(getNativeListing('p1'))).toMatch(/native intents/);
  });
});
