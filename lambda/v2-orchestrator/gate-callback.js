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
  return ownsAnsweredGate(gate, input) ? gate : null;
};

// An answered gate this callback may resume: no other callback or owner has
// claimed it, and (for stage gates) it belongs to the expected stage.
export const ownsAnsweredGate = (gate, input) =>
  isHumanTaskAnswerStatus(gate?.status) &&
  (gate.callbackId == null || gate.callbackId === input.callbackId) &&
  (gate.callbackOwner == null || gate.callbackOwner === input.callbackOwner) &&
  (input.stageInstanceId === undefined ||
    humanTaskMatchesOwner({
      task: { ...gate, stageInstanceId: gate.stageInstanceId ?? null },
      stageInstanceId: input.stageInstanceId,
      unitSlug: input.unitSlug,
      sectionIndex: input.sectionIndex,
    }));

// Shared by engine and stage gates. The mutation and its recovery check must
// agree on ownership: a committed write with a lost checkpoint is success.
export const unparkGate = async (store, { executionId, humanTaskId, runId, unitSlug = null }) => {
  // Lane gates never park META: another lane may own its single pending
  // gate pointer, and this lane's META status has remained RUNNING. The
  // conditional ownership update leaves that status and pointer intact.
  if (unitSlug) {
    try {
      await store.updateExecution({
        executionId,
        orchestratorRunId: runId,
        ifOrchestratorRunId: runId,
      });
      return true;
    } catch (error) {
      if (error?.name === 'ConditionalCheckFailedException') return false;
      throw error;
    }
  }
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
