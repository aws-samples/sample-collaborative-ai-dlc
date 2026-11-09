// Frozen load-meta body from main 22fdd2e305e9c72129bc114953eddff8e60f86a2, the
// deployed orchestrator before the autonomous loop-back. Do not modernize this
// fixture.
export const loadMetaBeforeAutonomousLoopBack = async (store, executionId) => {
  const loaded = await store.getExecution(executionId, {
    consistentRead: true,
  });
  return loaded ? { ...loaded, completionPolicyVersion: 1 } : null;
};
