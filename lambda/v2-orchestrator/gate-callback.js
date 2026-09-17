// Called inside a durable step. A failed pending-only bind can mean the human
// answered first, not that another callback owns the gate. Never replace an
// existing owner to recover that race.
export const bindGateCallback = async (store, input) => {
  const bound = await store.setGateCallbackId(input);
  if (bound) return bound;

  const gate = await store.getHumanTask(input.executionId, input.humanTaskId, {
    consistentRead: true,
  });
  if (gate?.status === 'superseded') return gate;
  if (!gate || !['answered', 'approved', 'rejected'].includes(gate.status)) return null;
  if (
    (gate.callbackId != null && gate.callbackId !== input.callbackId) ||
    (gate.callbackOwner != null && gate.callbackOwner !== input.callbackOwner) ||
    (input.stageInstanceId !== undefined &&
      (gate.stageInstanceId ?? null) !== input.stageInstanceId)
  ) {
    return null;
  }
  return gate;
};
