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
  Boolean(gate.answeredAt || gate.answer) &&
  (gate.callbackId == null || gate.callbackId === input.callbackId) &&
  (gate.callbackOwner == null || gate.callbackOwner === input.callbackOwner) &&
  (input.stageInstanceId === undefined ||
    humanTaskMatchesOwner({
      task: gate,
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
      resumeRequired: null,
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

// A gate answered before its callback was bound resumes without the callback.
// The answer route completes a gate's callback only when the answered row
// already carried that callbackId, so this one would stay pending for the rest
// of the run. The durable runtime suspends an invocation whenever no operation
// is running and any callback is pending, which turns every later pause
// between operations into a possible suspension with no wake-up. Complete it
// here, but only when the answer route can't: the gate holds another callback
// id, or none. Call it inside an existing durable step, so a replay doesn't
// send it twice and the operation sequence is unchanged. Best-effort: a
// failure logs and the run carries on.
export const releaseUnusedGateCallback = async (
  releaseCallback,
  { gate, callbackId, humanTaskId, logger = null },
) => {
  if (typeof releaseCallback !== 'function' || !callbackId) return false;
  if (!gate || gate.callbackId === callbackId) return false;
  try {
    await releaseCallback(callbackId, { released: 'gate_answered_early', humanTaskId });
    return true;
  } catch (error) {
    logger?.warn?.('unused gate callback not released', {
      humanTaskId,
      error: error?.name ?? String(error),
    });
    return false;
  }
};
