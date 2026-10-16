import { __durableHandler as handler } from '../../index.js';
import { repoUrl } from '../../../shared/repo-provider.js';
import { openIntentPrs } from '../../../shared/intent-pr.js';
import { withCompletionReads } from './completion-store.js';

// Upgrade the existing control-flow fakes to the persisted completion read
// contract. Production logic still runs; real conditional stores and deliberately
// incomplete snapshots are covered by the completion tests.
export const __durableHandler = (event, ctx, deps) =>
  handler(event, ctx, {
    ...deps,
    publishDelivery:
      deps.publishDelivery ??
      (({ store, meta, applicationUrl }) =>
        openIntentPrs({
          store,
          meta,
          applicationUrl,
          executionId: meta.executionId,
          runId: meta.orchestratorRunId,
          openPr: deps.openPr,
          comparePrBranches: deps.comparePrBranches,
        })),
    store: withCompletionReads(deps.store),
    invokeRuntime: async (...args) => {
      const result = await deps.invokeRuntime(...args);
      const [payload] = args;
      if (payload.command === 'merge-lane' && result?.ok && result.results === undefined) {
        return {
          ...result,
          results: (payload.repos ?? []).map((repo) => ({ repo: repoUrl(repo), merged: true })),
        };
      }
      return result;
    },
  });
