import { humanTaskMatchesOwner, isHumanTaskAnswerStatus } from '../shared/v2-process-keys.js';

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
  if (!isHumanTaskAnswerStatus(gate?.status)) return null;
  if (
    (gate.callbackId != null && gate.callbackId !== input.callbackId) ||
    (gate.callbackOwner != null && gate.callbackOwner !== input.callbackOwner) ||
    (input.stageInstanceId !== undefined &&
      !humanTaskMatchesOwner({
        task: { ...gate, stageInstanceId: gate.stageInstanceId ?? null },
        stageInstanceId: input.stageInstanceId,
        unitSlug: input.unitSlug,
        sectionIndex: input.sectionIndex,
      }))
  ) {
    return null;
  }
  return gate;
};

// Shared by engine and stage gates. The mutation and its recovery check must
// agree on ownership: a committed write with a lost checkpoint is success.
export const unparkGate = async (store, { executionId, humanTaskId, runId }) => {
  try {
    await store.updateExecution({
      executionId,
      status: 'RUNNING',
      pendingHumanTaskId: null,
      fromStatus: 'WAITING',
      ifOrchestratorRunId: runId,
      ifPendingHumanTaskId: humanTaskId,
    });
    return true;
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    const meta = await store.getExecution(executionId, { consistentRead: true });
    return Boolean(
      meta &&
      meta.orchestratorRunId === runId &&
      meta.status === 'RUNNING' &&
      !meta.pendingHumanTaskId,
    );
  }
};
