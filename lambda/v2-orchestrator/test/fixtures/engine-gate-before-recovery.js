// Frozen deployed implementation from 590ace6, before PR #466.
// Generates real durable checkpoints for cross-version replay coverage.
export const awaitEngineGate = async (
  ctxArg,
  toolkit,
  {
    name,
    prompt,
    options = null,
    kind = 'approval',
    stageInstanceId = null,
    unitSlug = null,
    sectionIndex = null,
    // Valid "skip to stage X" targets for a validation gate (stage-skip.js).
    // Advisory for the UI; the orchestrator re-validates the answer.
    skipTargets = null,
    // Valid recompose-delta targets (arbitrary later CONDITIONAL stages the
    // approve answer may flip to SKIP). Advisory only, same re-validation.
    recomposeTargets = null,
    // The COMPUTED next stage after this gate approves (upstream 2.2.6):
    // string = its stageId, null = approving completes the workflow,
    // undefined = not computed (non-validation gates) — the UI keeps its
    // generic labels. Display-only; never drives routing.
    nextStageId = undefined,
  },
) => {
  const { store, broadcast, ids, runId } = toolkit;
  const { executionId, intentId, projectId } = ids;
  const humanTaskId = `eg-${name}-${runId}`;

  // A prior attempt of THIS run may have already opened and even answered the
  // gate (resume after a suspend) — reuse the decision instead of hanging on
  // a callback nobody will complete.
  const existing = await ctxArg.step(`gate-pre-${name}`, () =>
    store.getHumanTask(executionId, humanTaskId).catch(() => null),
  );
  if (existing && existing.status === 'superseded') return { superseded: true };
  if (existing && existing.status !== 'pending') return { gate: existing };

  await ctxArg.step(`gate-open-${name}`, async () => {
    try {
      await store.createHumanTask({
        executionId,
        humanTaskId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        kind,
        prompt,
        options,
        ...(skipTargets ? { skipTargets } : {}),
        ...(recomposeTargets ? { recomposeTargets } : {}),
        ...(nextStageId !== undefined ? { nextStageId } : {}),
      });
    } catch {
      /* already exists from a prior attempt — idempotent open */
    }
    // Park META (WAITING + pointer): the cancel endpoint and the UI badge key
    // off it. Engine gates are barriers — no lanes are running while pending.
    try {
      await store.updateExecution({
        executionId,
        status: 'WAITING',
        pendingHumanTaskId: humanTaskId,
      });
    } catch {
      /* park bookkeeping is best-effort; the gate row is the truth */
    }
    try {
      await broadcast?.(intentId, {
        intentId,
        projectId,
        executionId,
        action: 'agent.question',
        humanTaskId,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        kind,
        prompt,
        options,
        ...(skipTargets ? { skipTargets } : {}),
        ...(recomposeTargets ? { recomposeTargets } : {}),
        ...(nextStageId !== undefined ? { nextStageId } : {}),
      });
    } catch {
      /* live fan-out is best-effort */
    }
  });

  const [callbackPromise, callbackId] = await ctxArg.createCallback(`await-${humanTaskId}`);
  const callbackBound = await ctxArg.step(`bind-callback-${humanTaskId}`, () =>
    store.setGateCallbackId({
      executionId,
      humanTaskId,
      callbackId,
      stageInstanceId: stageInstanceId ?? null,
      callbackOwner: `engine:${humanTaskId}`,
    }),
  );
  if (!callbackBound) {
    throw new Error(
      `gate_callback_conflict: ${humanTaskId} already has a different callback owner`,
    );
  }
  await callbackPromise;

  // Re-read after the wake: cancel/rewind supersedes and wakes with a
  // sentinel — that run owns META from here (same discipline as stage gates).
  const gate = await ctxArg.step(`gate-after-${name}`, () =>
    store.getHumanTask(executionId, humanTaskId).catch(() => null),
  );
  if (!gate || gate.status === 'superseded') return { superseded: true };
  await ctxArg.step(`gate-unpark-${name}`, async () => {
    try {
      await store.updateExecution({ executionId, status: 'RUNNING', pendingHumanTaskId: null });
    } catch {
      /* best-effort un-park */
    }
  });
  return { gate };
};
