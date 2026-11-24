import { queryOptions, skipToken } from '@tanstack/react-query';
import { querySessionOpen } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';
import { intentsService, type IntentDetail } from '@/services/intents';
import { workflowsService, type CompiledWorkflow, type PhaseNode } from '@/services/workflows';

/**
 * The one `qk.intentDetail` read (hover warm, pages, IntentProvider). A detail
 * this recent satisfies a mount without a request. A detail a page is reading
 * starts its compiled view at once, so the compile never waits for a render;
 * speculative reads leave the compile to the route prefetch and its budget.
 */
export function intentDetailQuery(projectId: string, intentId: string) {
  return queryOptions({
    queryKey: qk.intentDetail(projectId, intentId),
    staleTime: 5_000,
    structuralSharing: false,
    queryFn: async ({ signal, client, queryKey }) => {
      const detail = await intentsService.get(projectId, intentId, { signal });
      const observed = client.getQueryCache().find({ queryKey, exact: true })?.getObserversCount();
      if (querySessionOpen && observed && detail?.intent?.workflowId)
        void client.prefetchQuery(intentCompiledQuery(detail));
      return detail;
    },
  });
}

/**
 * The one compiled-workflow read for an existing intent: IntentContext and the
 * route prefetch both use it, so a prefetched compile is the provider's.
 * A release-pinned intent compiles that release's closure for this intent and
 * is keyed by the full pin (immutable: never stale). An unpinned intent
 * follows the live draft: 60 s fresh, and workflow writes invalidate it.
 * Without a detail (or a workflow) the query is idle.
 */
export function intentCompiledQuery(detail: IntentDetail | null | undefined) {
  const {
    workflowId = '',
    workflowVersion,
    methodologyRelease: pin,
    projectId,
    id,
  } = detail?.intent ?? {};
  const version = workflowVersion ?? undefined;
  const releaseId = pin?.releaseId;
  const importerRevision = pin?.importerRevision;
  const intent = pin && projectId && id ? { projectId, intentId: id } : undefined;
  return queryOptions({
    queryKey: qk.compiled(workflowId, { version, releaseId, importerRevision, intent }),
    gcTime: pin ? 5 * 60_000 : 60_000,
    staleTime: pin ? Infinity : 60_000,
    queryFn: workflowId
      ? ({ signal }): Promise<CompiledWorkflow & { phases?: PhaseNode[] }> =>
          workflowsService.compiled(
            workflowId,
            version,
            releaseId,
            importerRevision,
            intent,
            null,
            {
              signal,
            },
          )
      : skipToken,
  });
}
