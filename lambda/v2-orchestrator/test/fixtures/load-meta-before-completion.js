// Frozen load-meta body from main 4fd4558ae8b064d8d99efcbd905d38b0b853c27a,
// also used by the deployed pre-fix orchestrator. Do not modernize this fixture.
export const loadMetaBeforeCompletion = (store, executionId) =>
  store.getExecution(executionId, { consistentRead: true });
