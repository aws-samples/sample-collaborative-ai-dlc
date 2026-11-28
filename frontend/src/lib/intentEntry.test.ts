import { describe, it, expect, vi, beforeEach } from 'vitest';
import { QueryObserver, skipToken } from '@tanstack/react-query';

const intents = vi.hoisted(() => ({ get: vi.fn() }));
const get = vi.hoisted(() => vi.fn());

vi.mock('@/services/intents', () => ({ intentsService: intents }));
vi.mock('@/services/api', () => ({ api: { get } }));

import { intentDetailQuery, intentCompiledQuery } from './intentEntry';
import { qk } from './queryKeys';
import { queryClient } from './queryClient';
import type { IntentDetail } from '@/services/intents';

beforeEach(() => {
  intents.get.mockReset();
});

describe('intentDetailQuery', () => {
  it('keys the detail by project and intent and fetches it from the intents service', async () => {
    intents.get.mockResolvedValue({ intent: { id: 'i1' } });
    const query = intentDetailQuery('p1', 'i1');
    expect(query.queryKey).toEqual(['intent', 'p1', 'i1', 'detail']);
    expect(query.gcTime ?? 60_000).toBe(60_000);
    const controller = new AbortController();
    await expect(
      query.queryFn!({
        signal: controller.signal,
        meta: undefined,
        client: queryClient,
        queryKey: query.queryKey,
      }),
    ).resolves.toEqual({
      intent: { id: 'i1' },
    });
    expect(intents.get).toHaveBeenCalledWith('p1', 'i1', { signal: controller.signal });
  });
});

describe('intent entry dependencies', () => {
  const detail = (pin = false) =>
    ({
      intent: {
        id: 'i1',
        projectId: 'p1',
        workflowId: 'w1',
        workflowVersion: 3,
        status: 'SUCCEEDED',
        completedAt: '2026-11-23',
        methodologyRelease: pin ? { releaseId: 'aidlc:2', importerRevision: 4 } : null,
      },
    }) as IntentDetail;

  it('uses the unpinned provider key and forwards signal/meta', async () => {
    get.mockResolvedValue({ graph: { nodes: [], edges: [] } });
    const query = intentCompiledQuery(detail());
    expect(query.queryKey).toEqual(qk.compiled('w1', { version: 3 }));
    expect(query.staleTime).toBe(60_000);
    await queryClient.fetchQuery(query);
    expect(get).toHaveBeenLastCalledWith('/workflows/w1/compiled?version=3', {
      signal: expect.any(AbortSignal),
    });
  });

  it('keys the immutable compile by the full pin and existing intent context', async () => {
    get.mockResolvedValue({ graph: { nodes: [], edges: [] } });
    const query = intentCompiledQuery(detail(true));
    expect(query.queryKey).toEqual(
      qk.compiled('w1', {
        version: 3,
        releaseId: 'aidlc:2',
        importerRevision: 4,
        intent: { projectId: 'p1', intentId: 'i1' },
      }),
    );
    expect(query.staleTime).toBe(Infinity);
    expect(query.gcTime).toBe(5 * 60_000);
    await queryClient.fetchQuery(query);
    expect(get).toHaveBeenLastCalledWith(
      '/workflows/w1/compiled?version=3&release=aidlc%3A2&releaseImporterRevision=4&projectId=p1&intentId=i1',
      { signal: expect.any(AbortSignal) },
    );
  });

  it('starts the compiled view as soon as a read detail arrives, not for a prefetch', async () => {
    intents.get.mockResolvedValue(detail(true));
    get.mockResolvedValue({ graph: { nodes: [], edges: [] } });
    const compiledKey = intentCompiledQuery(detail(true)).queryKey;
    await queryClient.prefetchQuery(intentDetailQuery('p1', 'i1'));
    expect(queryClient.getQueryState(compiledKey)).toBeUndefined();
    queryClient.clear();
    const observer = new QueryObserver(queryClient, intentDetailQuery('p1', 'i1'));
    const stop = observer.subscribe(() => {});
    await vi.waitFor(() => expect(queryClient.getQueryState(compiledKey)).toBeDefined());
    stop();
  });

  it('stays idle without a detail', () => {
    expect(intentCompiledQuery(undefined).queryFn).toBe(skipToken);
  });
});
