import {
  assessExecutionCompletion,
  unverifiedCompletion,
  unitCompletion,
} from './unit-completion.js';

export const validateCompletionAuditScope = (scope) => {
  const { projectId, status = 'SUCCEEDED', from, to } = scope;
  const limits = {
    maxExecutions: scope.maxExecutions ?? 100,
    pageSize: scope.pageSize ?? 25,
    maxPages: scope.maxPages ?? 10,
    maxRecordsPerExecution: scope.maxRecordsPerExecution ?? 2000,
  };
  if (
    typeof projectId !== 'string' ||
    !projectId.trim() ||
    !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(status) ||
    !Number.isFinite(Date.parse(from)) ||
    !Number.isFinite(Date.parse(to)) ||
    new Date(from).toISOString() !== from ||
    new Date(to).toISOString() !== to ||
    from >= to
  ) {
    throw new Error('Explicit project and ISO UTC start-time interval [from, to) are required');
  }
  for (const [key, min, max] of [
    ['maxExecutions', 1, 1000],
    ['pageSize', 1, 100],
    ['maxPages', 1, 100],
    ['maxRecordsPerExecution', 2, 10000],
  ]) {
    if (!Number.isInteger(limits[key]) || limits[key] < min || limits[key] > max) {
      throw new Error(`${key} must be ${min}..${max}`);
    }
  }
  return { projectId, status, from, to, ...limits };
};

// Stateless, read-only batches. Checkpoints bind the full scope, so resuming
// cannot accidentally widen the project/time window. Every discovered META is
// verified on the base table; GSI lag and concurrent recovery are not corruption.
export const auditCompletion = async ({
  store,
  loadPlan,
  scope: input,
  checkpoint = null,
  budget = null,
}) => {
  const scope = validateCompletionAuditScope(input);
  if (
    checkpoint &&
    (checkpoint.version !== 2 || JSON.stringify(checkpoint.scope) !== JSON.stringify(scope))
  ) {
    throw new Error('Completion audit checkpoint scope differs');
  }
  let cursor = checkpoint?.cursor ?? null;
  const findings = [];
  const metrics = {
    examined: 0,
    complete: 0,
    partial: 0,
    incomplete: 0,
    unknown: 0,
    aborted: 0,
  };
  let pages = 0;
  let discoveryUnverified = false;
  let budgetExhausted = false;
  audit: do {
    let page;
    try {
      page = await store.listCompletionAuditPage({
        ...scope,
        limit: Math.min(scope.pageSize, scope.maxExecutions - metrics.examined),
        cursor,
      });
    } catch {
      if (budget?.exhausted) budgetExhausted = true;
      else discoveryUnverified = true;
      break;
    }
    pages++;
    for (const candidate of page.items) {
      let records;
      let completion;
      try {
        records = await store.getCompletionRecords(candidate.executionId, {
          maxRecords: scope.maxRecordsPerExecution,
        });
        const meta = records.meta;
        if (
          !meta ||
          meta.projectId !== scope.projectId ||
          meta.status !== scope.status ||
          !Number.isFinite(Date.parse(meta.startedAt)) ||
          meta.startedAt < scope.from ||
          meta.startedAt >= scope.to
        ) {
          completion = unverifiedCompletion('execution_scope_changed');
        } else {
          // A legacy execution without unit work has no unit diagnostic. Use
          // the same owner's no-section result for audit counts.
          completion =
            (await assessExecutionCompletion({ records, loadPlan })) ?? unitCompletion(records, []);
          const current = await store.getExecution(candidate.executionId, {
            consistentRead: true,
          });
          const currentPlan = await store.getUnitPlan(candidate.executionId, {
            consistentRead: true,
          });
          if (
            !current ||
            current.orchestratorRunId !== meta.orchestratorRunId ||
            current.updatedAt !== meta.updatedAt ||
            current.status !== meta.status ||
            JSON.stringify(currentPlan) !== JSON.stringify(records.unitPlan)
          ) {
            completion = unverifiedCompletion('execution_changed_during_audit');
          }
        }
      } catch {
        completion = unverifiedCompletion('completion_read_failed');
      }
      // Plan resolution can catch a failed read itself. The budget retains
      // exhaustion even through those catches; no partial assessment advances
      // the cursor or becomes an examined/unknown execution.
      if (budget?.exhausted) {
        budgetExhausted = true;
        break audit;
      }
      metrics.examined++;
      metrics[completion.state]++;
      findings.push({
        type: 'execution.completion',
        projectId: scope.projectId,
        intentId: candidate.intentId ?? candidate.executionId,
        executionId: candidate.executionId,
        runId:
          records?.meta?.projectId === scope.projectId
            ? (records.meta.orchestratorRunId ?? null)
            : null,
        status: scope.status,
        ...completion,
      });
      cursor = candidate.cursor;
    }
    cursor = page.cursor;
  } while (cursor && pages < scope.maxPages && metrics.examined < scope.maxExecutions);
  return {
    findings,
    summary: {
      type: 'execution.completion.summary',
      scope,
      pages,
      metrics,
      finished: !cursor && !discoveryUnverified && !budgetExhausted,
      discoveryUnverified,
      budgetExhausted,
      stopReason: budgetExhausted ? 'budget_exhausted' : null,
    },
    checkpoint:
      cursor || discoveryUnverified || budgetExhausted ? { version: 2, scope, cursor } : null,
  };
};
