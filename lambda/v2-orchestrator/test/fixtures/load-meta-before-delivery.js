// Frozen load-meta boundary from the corrected preventive completion policy (PR #534).
export const loadMetaBeforeDelivery = async (store, executionId) => {
  const loaded = await store.getExecution(executionId, { consistentRead: true });
  return loaded ? { ...loaded, completionPolicyVersion: 1 } : null;
};
