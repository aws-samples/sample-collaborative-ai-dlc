// Frozen load-meta body from main 4fd4558ae8b064d8d99efcbd905d38b0b853c27a,
// also used by the deployed pre-fix orchestrator. Do not modernize this fixture.
export const loadMetaBeforeCompletion = (store, executionId) =>
  store.getExecution(executionId, { consistentRead: true });

// Frozen finish-succeeded body from main c4b6afff3147be23c567492b3a5ea9e692af7e0f.
export const finishSucceededBeforeCompletion = async ({
  store,
  executionId,
  projectId,
  meta,
  runId,
}) => {
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
