import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { resolveRoute } from '@/routes/registry';
import { queryClient } from './queryClient';
import { bindUserCache, endUserCache } from './persistentCache';
import { foregroundNavigation } from './prefetch';
import {
  cancelHrefPrefetch,
  notifyNavigation,
  prefetchHref,
  setRoutePrefetchContext,
} from './routePrefetch';
import { qk } from './queryKeys';
import type { IntentDetail } from '@/services/intents';
import { intentCompiledQuery } from './intentEntry';

const apiGet = vi.hoisted(() => vi.fn());
const preload = vi.hoisted(() => vi.fn(async () => undefined));
vi.mock('@/services/api', () => ({ api: { get: apiGet } }));
vi.mock('@/routes/pages', async (importOriginal) => {
  const actual = await importOriginal<Record<string, object>>();
  return Object.fromEntries(
    Object.entries(actual).map(([name, page]) => [name, { ...page, preload }]),
  );
});

const admin = { isPlatformAdmin: true };
const small = '/space/p/intent/small/observability';
const detail = {
  intent: { id: 'small', projectId: 'p', workflowId: 'w', workflowVersion: 2 },
} as IntentDetail;

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  queryClient.clear();
  setRoutePrefetchContext(() => ({ user: { isPlatformAdmin: false }, currentHref: '' }));
  foregroundNavigation(undefined, 0);
  Object.defineProperty(navigator, 'connection', { value: undefined, configurable: true });
  apiGet.mockResolvedValue(detail);
});
afterEach(() => {
  foregroundNavigation();
  queryClient.clear();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('route prefetch execution', () => {
  it.each([
    '/space/p/intent/metrics/observability',
    '/space/p/intent/i%2Foutputs/observability',
    '/space/..%2Fenvironments%2Fcapabilities/settings',
    '/space/%2e%2e/settings',
    '/space/p/intent/i%252Foutputs/observability',
    '/space/p/intent/i%3Fignored/observability',
  ])('rejects endpoint-confusing identifiers before chunk or data requests: %s', (href) => {
    prefetchHref(href, { user: admin });
    prefetchHref(href, { user: admin, trigger: 'pointerdown' });
    expect(preload).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'upgrades idle to hover with dependent compilation (already settled=%s)',
    async (settled) => {
      prefetchHref(small, { trigger: 'idle' });
      if (settled) await vi.advanceTimersByTimeAsync(2_000);
      prefetchHref(small, { trigger: 'hover' });
      await vi.advanceTimersByTimeAsync(0);
      expect(apiGet).toHaveBeenCalledWith('/workflows/w/compiled?version=2', expect.anything());
      expect(
        apiGet.mock.calls.filter(
          ([path]) => path === '/projects/p/intents/small?artifactContent=separate',
        ),
      ).toHaveLength(1);
    },
  );

  it('ignores the active route/hash and lets query freshness dedupe repeats', async () => {
    prefetchHref(small, { currentHref: `${small}#top` });
    expect(preload).not.toHaveBeenCalled();
    prefetchHref(small);
    prefetchHref(small);
    await vi.advanceTimersByTimeAsync(0);
    prefetchHref(small);
    const detailReads = () =>
      apiGet.mock.calls.filter(([path]) => String(path).startsWith('/projects/p/intents/small'));
    expect(detailReads()).toHaveLength(1);
  });

  it('non-admin and closed sessions warm neither code nor data', () => {
    prefetchHref('/workflows');
    expect(preload).not.toHaveBeenCalled();
    endUserCache('logout');
    prefetchHref(small, { trigger: 'pointerdown' });
    expect(preload).not.toHaveBeenCalled();
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('Save-Data suppresses hover chunks/data but pointerdown still loads the chunk only', () => {
    Object.defineProperty(navigator, 'connection', {
      value: { saveData: true },
      configurable: true,
    });
    prefetchHref(small);
    expect(preload).not.toHaveBeenCalled();
    prefetchHref(small, { trigger: 'pointerdown' });
    expect(preload).toHaveBeenCalledTimes(1);
    expect(apiGet).not.toHaveBeenCalled();
  });

  it('heavy hover loads only code; pointerdown upgrades within the dedupe window', async () => {
    const graph = '/space/p/intent/i/graph';
    prefetchHref(graph);
    expect(apiGet).not.toHaveBeenCalled();
    apiGet.mockResolvedValue({ ...detail, nodes: [], edges: [] });
    prefetchHref(graph, { trigger: 'pointerdown' });
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledWith(
      '/projects/p/intents/i?artifactContent=separate',
      expect.anything(),
    );
  });

  it('schedules compiled from the committed critical detail, including a cached detail', async () => {
    let complete!: (data: IntentDetail) => void;
    apiGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    prefetchHref(small);
    expect(apiGet).toHaveBeenCalledTimes(1);
    complete(detail);
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledWith('/workflows/w/compiled?version=2', expect.anything());
    queryClient.clear();
    apiGet.mockClear();
    setRoutePrefetchContext(() => ({ user: { isPlatformAdmin: false }, currentHref: '' }));
    queryClient.setQueryData(qk.intentDetail('p', 'small'), detail);
    prefetchHref(small);
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith(
      '/workflows/w/compiled?version=2',
      expect.anything(),
    );
  });

  it('warms a pinned compile under the key IntentContext reads (the full pin)', async () => {
    const pinned = {
      intent: {
        ...detail.intent,
        methodologyRelease: { releaseId: 'aidlc:2', importerRevision: 4 },
      },
    } as IntentDetail;
    queryClient.setQueryData(qk.intentDetail('p', 'small'), pinned);
    apiGet.mockResolvedValue({ graph: { nodes: [], edges: [] } });
    prefetchHref(small);
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalledExactlyOnceWith(
      '/workflows/w/compiled?version=2&release=aidlc%3A2&releaseImporterRevision=4&projectId=p&intentId=small',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    const key = qk.compiled('w', {
      version: 2,
      releaseId: 'aidlc:2',
      importerRevision: 4,
      intent: { projectId: 'p', intentId: 'small' },
    });
    expect(intentCompiledQuery(pinned).queryKey).toEqual(key);
    expect(queryClient.getQueryState(key)?.data).toEqual({ graph: { nodes: [], edges: [] } });
  });

  it('does not schedule dependencies after navigating away or after session change', async () => {
    let complete!: (data: IntentDetail) => void;
    apiGet.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          complete = resolve;
        }),
    );
    prefetchHref(small);
    notifyNavigation('/dashboard', admin);
    complete(detail);
    await vi.advanceTimersByTimeAsync(500);
    expect(apiGet).toHaveBeenCalledTimes(1);
  });

  it('reads no hover data for a large cached intent, and does once it is gone', async () => {
    await queryClient.fetchQuery({
      queryKey: qk.intentDetail('p', 'small'),
      queryFn: async () => ({ ...detail, artifacts: [{ content: 'x'.repeat(600 * 1024) }] }),
    });
    await vi.advanceTimersByTimeAsync(6_000);
    prefetchHref(small);
    await vi.advanceTimersByTimeAsync(300);
    expect(apiGet).not.toHaveBeenCalled();
    endUserCache('logout');
    bindUserCache('route-test');
    prefetchHref(small);
    await vi.advanceTimersByTimeAsync(300);
    expect(apiGet).toHaveBeenCalled();
  });

  it('canceling queued work allows a later hover to retry', async () => {
    prefetchHref(small, { trigger: 'idle' });
    cancelHrefPrefetch(small);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(apiGet).not.toHaveBeenCalled();
    prefetchHref(small);
    await vi.advanceTimersByTimeAsync(0);
    expect(apiGet).toHaveBeenCalled();
  });

  it('never schedules audit, graph, compiled, outputs, metrics or capabilities at idle', async () => {
    prefetchHref('/space/p/intent/i/audit', { trigger: 'idle' });
    await vi.advanceTimersByTimeAsync(2_000);
    const paths = apiGet.mock.calls.map(([path]) => String(path));
    expect(paths).toEqual(['/projects/p/intents/i?artifactContent=separate']);
    expect(resolveRoute('/auth/callback')).toBeUndefined();
  });
});
