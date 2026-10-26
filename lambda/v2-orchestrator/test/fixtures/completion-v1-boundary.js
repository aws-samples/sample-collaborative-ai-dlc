// Frozen boundary bodies from 7c30a8656eff914e776f9d3527f1b1ef0c2e197d
// (#534). Do not modernize: only these changed boundaries need freezing.
export const loadMetaV1 = async (store, executionId) => {
  const loaded = await store.getExecution(executionId, { consistentRead: true });
  return loaded ? { ...loaded, completionPolicyVersion: 1 } : null;
};

export const finishSucceededV1 = async ({ store, executionId, projectId, meta, runId }) => {
  try {
    await store.updateExecution({
      executionId,
      projectId,
      status: 'SUCCEEDED',
      startedAt: meta.startedAt,
      completedAt: new Date().toISOString(),
      failureReason: null,
      failure: null,
      ...(runId ? { ifOrchestratorRunId: runId } : {}),
    });
    return true;
  } catch (e) {
    if (e?.name === 'ConditionalCheckFailedException') return false;
    throw e;
  }
};
