// Quorum-supported artifact edit — the durable flow that drives one QEDIT
// session end to end (post-hoc document editing).
//
// Triggered (async Invoke) by lambda/intents on POST .../quorum-edit. The flow
// is deterministic process control; ALL graph work (impact analysis, content
// rewriting, stale bookkeeping, re-derivation) happens inside the AgentCore
// container commands — the orchestrator is not VPC-attached and reaches
// Neptune only through the runtime, exactly like stage runs.
//
//   1. PLAN   — durable callback + `quorum-edit-plan-start` (accept-then-
//               background job, run-stage-start pattern). Quorum reads the
//               target artifact + its downstream closure and answers with a
//               structured per-artifact update plan.
//   2. DECIDE — the plan lands on the QEDIT row (AWAITING_APPROVAL) and the
//               flow suspends on a decision callback. lambda/intents completes
//               it when the human approves/rejects (the gate-answer pattern).
//   3. APPLY  — approved: durable callback + `quorum-edit-apply-start`. The
//               container rewrites the target + each approved artifact,
//               clears/sets stale markers, re-derives the projection.
//   4. FINAL  — terminal QEDIT state + timeline event + reload-hint broadcast.
//
// REPLAY DISCIPLINE: every side effect lives inside ctx.step(...) — same rule
// as index.js. Callback names carry the editId so two edits are distinct
// durable identities.

const nowIso = () => new Date().toISOString();

// The plan phase is one bounded LLM call over a small artifact set; the apply
// phase is N bounded calls. Generous ceilings, tight heartbeats (the container
// job beats every ~60s, so a dead container surfaces in minutes).
const PLAN_CALLBACK_TIMEOUT = { hours: 1 };
const APPLY_CALLBACK_TIMEOUT = { hours: 4 };
const CALLBACK_HEARTBEAT_TIMEOUT = { minutes: 15 };
// The human decision has no heartbeat — a parked approval can legitimately
// sit for days (mirrors human gates).
const DECISION_CALLBACK_TIMEOUT = { hours: 72 };

// Dedicated AgentCore session per intent for quorum edits — never the stage
// session (a parked stage conversation must not be disturbed) and ≥33 chars.
export const quorumEditSessionIdFor = (intentId) => `aidlc-qedit-${intentId}`.padEnd(33, '0');

// Decode a callback completion body (pass-through serdes: raw JSON string).
const decodeCallback = (raw) => {
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
};

export const runQuorumEdit = async (event, ctx, deps) => {
  const { store, invokeRuntime, stopSession, broadcast } = deps;
  const { intentId, executionId, editId } = event;
  if (!intentId || !executionId || !editId) return { ok: false, reason: 'missing_identity' };

  const meta = await ctx.step('qe-load-meta', () => store.getExecution(executionId));
  if (!meta) return { ok: false, reason: 'execution_not_found' };
  const edit = await ctx.step('qe-load-edit', () => store.getQuorumEdit(executionId, editId));
  if (!edit) return { ok: false, reason: 'quorum_edit_not_found' };
  const { projectId } = meta;
  const sessionId = quorumEditSessionIdFor(intentId);

  // Timeline event + payload-blind reload hint, both best-effort and inside a
  // durable step (a replayed broadcast is harmless — the UI just refetches).
  const emit = (stepName, type, summary) =>
    ctx.step(stepName, async () => {
      try {
        await store.appendEvent?.({ executionId, type, actor: 'quorum', summary });
      } catch {
        /* events are best-effort telemetry */
      }
      try {
        await broadcast?.(intentId, {
          intentId,
          projectId,
          action: 'agent.note',
          noteType: 'v2.quorum_edit.updated',
          summary,
        });
      } catch {
        /* live fan-out is best-effort */
      }
    });

  // Terminal FAILED write + event. Returned as a value — one decode path.
  const fail = async (reason, detail) => {
    const message = detail ? `${reason}: ${detail}` : reason;
    await ctx.step(`qe-fail-${reason}`, () =>
      store
        .updateQuorumEdit({
          executionId,
          editId,
          state: 'FAILED',
          fields: { failureReason: message, completedAt: nowIso() },
        })
        .catch(() => null),
    );
    await emit('qe-fail-event', 'v2.quorum_edit.failed', `Quorum edit failed (${message})`);
    return { ok: false, reason, detail: detail ?? null };
  };

  try {
    // ── 1. PLAN ──────────────────────────────────────────────────────────────
    const [planDone, planCallbackId] = await ctx.createCallback(`qe-plan-cb-${editId}`, {
      timeout: PLAN_CALLBACK_TIMEOUT,
      heartbeatTimeout: CALLBACK_HEARTBEAT_TIMEOUT,
    });
    const planDispatch = await ctx.step(`qe-plan-dispatch-${editId}`, () =>
      invokeRuntime(
        {
          command: 'quorum-edit-plan-start',
          projectId,
          intentId,
          executionId,
          editId,
          artifactId: edit.artifactId,
          changeDescription: edit.changeDescription,
          requestedByName: edit.requestedByName ?? '',
          ...(meta.agentCli ? { requestedCli: meta.agentCli } : {}),
          ...(meta.cliModels ? { cliModels: meta.cliModels } : {}),
          ...(meta.tierModels ? { tierModels: meta.tierModels } : {}),
          callbackId: planCallbackId,
        },
        sessionId,
      ),
    );
    if (!planDispatch || planDispatch.ok === false || planDispatch.error) {
      return await fail(
        planDispatch?.reason ?? 'plan_dispatch_failed',
        planDispatch?.detail ?? planDispatch?.error ?? null,
      );
    }
    let planResult;
    try {
      planResult = decodeCallback(await planDone);
    } catch (err) {
      return await fail('plan_callback_failed', err?.message ?? String(err));
    }
    if (!planResult || planResult.ok === false) {
      return await fail(planResult?.reason ?? 'plan_failed', planResult?.detail ?? null);
    }
    const plan = planResult.plan ?? null;
    if (!plan || !Array.isArray(plan.items)) {
      return await fail('plan_malformed');
    }

    // ── 2. DECIDE ────────────────────────────────────────────────────────────
    const [decisionDone, decisionCallbackId] = await ctx.createCallback(
      `qe-decision-cb-${editId}`,
      { timeout: DECISION_CALLBACK_TIMEOUT },
    );
    const parked = await ctx.step(`qe-awaiting-${editId}`, () =>
      store.updateQuorumEdit({
        executionId,
        editId,
        state: 'AWAITING_APPROVAL',
        fromStates: ['PLANNING'],
        fields: { plan, callbackId: decisionCallbackId },
      }),
    );
    if (!parked) {
      // The row left PLANNING underneath us (deleted/failed elsewhere) —
      // nothing sane to park on.
      return await fail('awaiting_transition_lost');
    }
    await emit(
      'qe-awaiting-event',
      'v2.quorum_edit.plan_ready',
      `Quorum proposed an update plan for "${edit.artifactTitle || edit.artifactId}" (${plan.items.length} downstream artifact(s)) — awaiting approval`,
    );

    let decisionRaw;
    try {
      decisionRaw = decodeCallback(await decisionDone);
    } catch (err) {
      // Decision callback timeout — retire the session as CANCELLED so it no
      // longer blocks other edits.
      await ctx.step(`qe-decision-timeout-${editId}`, () =>
        store
          .updateQuorumEdit({
            executionId,
            editId,
            state: 'CANCELLED',
            fromStates: ['AWAITING_APPROVAL', 'APPLYING'],
            fields: {
              failureReason: `decision_timeout: ${err?.message ?? 'expired'}`,
              completedAt: nowIso(),
            },
          })
          .catch(() => null),
      );
      await emit(
        'qe-decision-timeout-event',
        'v2.quorum_edit.cancelled',
        'Quorum edit retired — the plan was never approved or rejected',
      );
      return { ok: false, reason: 'decision_timeout' };
    }
    // The intents lambda wraps the decision as { answer: {...} } (shared
    // resumeDurableCallback); tolerate a bare object for tests/tools.
    const decision = decisionRaw?.answer ?? decisionRaw ?? {};
    if (decision.decision !== 'approve') {
      // The endpoint already CAS'd the row to REJECTED; just close the loop.
      await emit(
        'qe-rejected-event',
        'v2.quorum_edit.rejected',
        `Quorum's update plan for "${edit.artifactTitle || edit.artifactId}" was rejected — nothing was changed`,
      );
      return { ok: true, editId, rejected: true };
    }
    const approvedArtifactIds = Array.isArray(decision.approvedArtifactIds)
      ? decision.approvedArtifactIds
      : [];

    // ── 3. APPLY ─────────────────────────────────────────────────────────────
    const [applyDone, applyCallbackId] = await ctx.createCallback(`qe-apply-cb-${editId}`, {
      timeout: APPLY_CALLBACK_TIMEOUT,
      heartbeatTimeout: CALLBACK_HEARTBEAT_TIMEOUT,
    });
    const applyDispatch = await ctx.step(`qe-apply-dispatch-${editId}`, () =>
      invokeRuntime(
        {
          command: 'quorum-edit-apply-start',
          projectId,
          intentId,
          executionId,
          editId,
          artifactId: edit.artifactId,
          changeDescription: edit.changeDescription,
          approvedArtifactIds,
          decidedBy: decision.decidedBy ?? null,
          decidedByName: decision.decidedByName ?? null,
          enrichment: meta.deriveEnrichment === 'llm' ? 'llm' : 'off',
          ...(meta.agentCli ? { requestedCli: meta.agentCli } : {}),
          ...(meta.cliModels ? { cliModels: meta.cliModels } : {}),
          ...(meta.tierModels ? { tierModels: meta.tierModels } : {}),
          callbackId: applyCallbackId,
        },
        sessionId,
      ),
    );
    if (!applyDispatch || applyDispatch.ok === false || applyDispatch.error) {
      return await fail(
        applyDispatch?.reason ?? 'apply_dispatch_failed',
        applyDispatch?.detail ?? applyDispatch?.error ?? null,
      );
    }
    let applyResult;
    try {
      applyResult = decodeCallback(await applyDone);
    } catch (err) {
      return await fail('apply_callback_failed', err?.message ?? String(err));
    }
    if (!applyResult) return await fail('apply_bad_callback_result');

    // ── 4. FINAL ─────────────────────────────────────────────────────────────
    const succeeded = applyResult.ok !== false;
    await ctx.step(`qe-final-${editId}`, () =>
      store
        .updateQuorumEdit({
          executionId,
          editId,
          state: succeeded ? 'SUCCEEDED' : 'FAILED',
          fields: {
            updatedArtifactIds: applyResult.updatedArtifactIds ?? [],
            verifiedArtifactIds: applyResult.verifiedArtifactIds ?? [],
            failedArtifactIds: applyResult.failedArtifactIds ?? [],
            failureReason: succeeded ? null : (applyResult.reason ?? 'apply_failed'),
            completedAt: nowIso(),
          },
        })
        .catch(() => null),
    );
    // Mid-run edit (the run is parked WAITING on a gate): the parked CLI
    // conversation still holds the OLD document contents. Record a steering
    // row so the next deterministic injection point (gate resume / fresh
    // stage start) tells the resumed agent to re-read the changed documents.
    // Gate answers and /start are refused while this flow runs, so the run is
    // still parked here — re-read META anyway (a cancel may have retired it).
    if (succeeded) {
      await ctx.step(`qe-steer-${editId}`, async () => {
        try {
          const current = await store.getExecution(executionId);
          if (current?.status !== 'WAITING') return;
          const changedIds = [edit.artifactId, ...(applyResult.updatedArtifactIds ?? [])];
          await store.createSteering?.({
            executionId,
            kind: 'artifact-edit',
            message: `Quorum applied an approved edit while this run was parked: "${edit.artifactTitle || edit.artifactId}" changed (${edit.changeDescription}). Re-read these artifacts with get_artifact before continuing — their CURRENT content overrides anything read earlier in this conversation: ${changedIds.join(', ')}.`,
            createdBy: edit.requestedBy ?? null,
            createdByName: edit.requestedByName ?? 'Quorum',
          });
        } catch {
          /* steering is best-effort — the stale markers already tell the story */
        }
      });
    }
    await emit(
      'qe-final-event',
      succeeded ? 'v2.quorum_edit.succeeded' : 'v2.quorum_edit.failed',
      succeeded
        ? `Quorum edit applied: "${edit.artifactTitle || edit.artifactId}" updated, ${
            (applyResult.updatedArtifactIds ?? []).length
          } downstream artifact(s) updated, ${
            (applyResult.verifiedArtifactIds ?? []).length
          } verified unaffected${
            (applyResult.failedArtifactIds ?? []).length
              ? `, ${(applyResult.failedArtifactIds ?? []).length} left stale (update failed)`
              : ''
          }`
        : `Quorum edit failed while applying (${applyResult.reason ?? 'unknown'})`,
    );
    // Free the dedicated microVM — the session's work is done.
    await ctx.step(`qe-stop-session-${editId}`, () =>
      stopSession ? stopSession(sessionId) : { stopped: false },
    );
    return { ok: succeeded, editId };
  } catch (err) {
    ctx.logger?.error?.('quorum edit flow failed', { intentId, editId, error: err?.message });
    return await fail('quorum_edit_error', err?.message ?? String(err));
  }
};

export default { runQuorumEdit, quorumEditSessionIdFor };
