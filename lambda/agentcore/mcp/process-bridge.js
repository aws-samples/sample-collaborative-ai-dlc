// Process bridge for the MCP server's collaboration/process tools.
//
// Business writes go to Neptune via graph-writer; PROCESS writes go to the v2
// DynamoDB process table + the realtime websocket here:
//   - ask_question     opens a pending HUMAN# gate, mirrors a Question vertex,
//                      broadcasts it, parks the stage WAITING, then either returns
//                      a fast inline answer (within a grace window) or a PARKED
//                      sentinel so the CLI exits and the session can go idle.
//   - send_output      persists an OUTPUT# chunk (restore-on-reload) AND
//                      broadcasts it live.
//   - collect_metric   appends a METRIC# row (token usage, context window %).
//   - emit_stage_note  appends an EVENT# audit row.
//
// Scope (executionId / intentId / stageInstanceId) comes from the trusted
// container ENV, never tool args. Everything effectful is injected (store,
// graph-writer, broadcast, clock, ids, sleep) so the suite runs the whole flow —
// including the blocking poll — with no AWS and no real timers.

import { randomUUID, createHash } from 'node:crypto';
import { LOOP_BACK_RECOMMENDED_EVENT } from '../../shared/stage-loopback.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';

const DEFAULT_POLL_MS = 3000;
// How long ask_question waits inline before PARKING. A near-instant answer still
// returns inline (today's fast-path UX); past the grace window the question parks
// so the CLI exits and the session can go idle (see docs/v2-resume.md).
const DEFAULT_PARK_GRACE_MS = 12000;

// The consolidated-confirmation checkpoint family.
//
// A checkpoint is an ask_question with THREE things the platform owns rather than
// the agent: the two exact option labels, the receipt the positive label writes,
// and the digest binding that receipt to the content the human actually saw.
// Owning the labels server-side is what lets the completion ladder tell "this was
// THE confirmation" from "this was an ordinary question" without matching prose,
// and lets it refuse authority to any other answer shape (upstream §1.4).
const CHECKPOINTS = Object.freeze({
  'summary-confirmation': Object.freeze({
    receiptKind: 'summary-confirmation',
    approve: 'Looks correct',
    reject: 'Request changes',
    question: 'Does this all look correct before I generate the artifacts?',
    events: Object.freeze({
      requested: 'v2.summary.requested',
      confirmed: 'v2.summary.confirmed',
      changesRequested: 'v2.summary.changes_requested',
    }),
  }),
  'plan-approval': Object.freeze({
    receiptKind: 'plan-approval',
    approve: 'Approve plan',
    reject: 'Request changes',
    question: 'Do you approve this implementation plan before I write any code?',
    events: Object.freeze({
      requested: 'v2.plan.requested',
      confirmed: 'v2.plan.approved',
      changesRequested: 'v2.plan.changes_requested',
    }),
  }),
});

const CHECKPOINT_MAX_ROUNDS = 12;

// Why an answered gate may still authorize NOTHING. Read on the resume leg, where
// the gate row is the only evidence left, so each rule closes a way a row that is
// not a human decision could mint an authorization:
//   - no `answeredBy`: nothing recorded WHO decided. That is a machine-written or
//     truncated row, and an authorization with no human attached is not one.
//   - no `boundDigest`: the gate carries no record of WHAT the human saw, so a
//     receipt minted from it could not be checked against anything later.
const authorizationRefusal = (gate) => {
  if (!gate?.answeredBy) return 'the answered gate records no answeredBy';
  if (!gate?.detail?.boundDigest) return 'the answered gate carries no boundDigest';
  return null;
};

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

// The human's chosen label, across every answer shape the answer endpoints write
// (`perQuestion[]`, `freeText`, or a bare string — see run-stage formatResumeAnswer).
const chosenLabel = (answer) => {
  if (typeof answer === 'string') return answer.trim();
  const perQuestion = Array.isArray(answer?.perQuestion) ? answer.perQuestion[0]?.answer : null;
  return String(perQuestion ?? answer?.freeText ?? answer?.decision ?? '').trim();
};

export const createProcessBridge = ({
  store,
  graphWriter = null,
  broadcast = async () => {},
  scope = {},
  pollIntervalMs = DEFAULT_POLL_MS,
  parkGraceMs = DEFAULT_PARK_GRACE_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  ids = randomUUID,
} = {}) => {
  if (!store) throw new Error('createProcessBridge requires a process store');
  if (!scope.executionId) throw new Error('createProcessBridge requires scope.executionId');
  const {
    executionId,
    intentId = null,
    stageId = null,
    stageInstanceId = null,
    unitSlug = null,
    sectionIndex = null,
    model = null,
    reviewerAgent = null,
    stageAttempt = 0,
    // The resolved release policy, or null for a 2.3.3/unpinned run. Its presence
    // is what turns artifact stamping on; the checkpoint tools are registered (or
    // withheld) from the same value in mcp/server.js.
    policy = null,
    checkpointOwner = true,
  } = scope;
  const attempt = Number(stageAttempt) || 0;

  // The authorization the NEXT artifact write is stamped with — the receipt SK of
  // the confirmation the human actually gave for this (stage, attempt). Process
  // memory is only a cache: it is rehydrated from the durable receipt at
  // construction, because a parked confirmation is answered in a DIFFERENT
  // container than the one that raised it.
  let activeAuthorizationId = null;

  // Park the stage on an already-opened gate, then wait a BOUNDED grace window.
  // The resume lambda answers the gate (CAS on pending). If it lands within the
  // window, return inline (restore RUNNING); otherwise PARK — return a sentinel
  // telling the agent to stop so the CLI exits cleanly. Keeping the wait bounded
  // is what lets /ping drop to Healthy and the session go idle.
  //
  // Shared verbatim by ask_question and every checkpoint, so a parked checkpoint
  // inherits the same callback binding, supersede, deadline and cancel paths.
  const parkAndPoll = async ({ humanTaskId, parkedMessage }) => {
    // A lane question parks only its stage. One META pointer cannot represent
    // concurrent lane gates and previously caused sibling stages to adopt this
    // question. Non-lane stages retain the legacy execution mirror for the
    // linear workflow UI; HUMAN#/STAGE# rows remain authoritative everywhere.
    if (!unitSlug) {
      await store.updateExecution({
        executionId,
        status: 'WAITING',
        pendingHumanTaskId: humanTaskId,
      });
    }
    if (stageInstanceId) {
      await store
        .updateStageState({
          executionId,
          stageInstanceId,
          state: 'WAITING_FOR_HUMAN',
          pendingHumanTaskId: humanTaskId,
          // Human-wait accounting starts at the ASK, not the CLI exit: the
          // human is already waiting while the agent winds down its turn.
          parkedAt: true,
        })
        .catch(() => {});
    }

    const maxPolls = Math.max(0, Math.floor(parkGraceMs / pollIntervalMs));
    for (let i = 0; i < maxPolls; i += 1) {
      await sleep(pollIntervalMs);
      const task = await store.getHumanTask(executionId, humanTaskId);
      if (task && task.status !== 'pending') {
        // Answered in time: clear the gate, un-park, and return the answer as before.
        if (!unitSlug) {
          await store.updateExecution({
            executionId,
            status: 'RUNNING',
            pendingHumanTaskId: null,
          });
        }
        if (stageInstanceId) {
          // resumeStageRow folds the parked window into waitMs and clears
          // parkedAt — the inline answer ends the human wait right here. If that
          // write fails, stop the agent turn and let the orchestrator resume it;
          // otherwise run-stage would still see the durable park marker.
          try {
            await store.resumeStageRow({ executionId, stageInstanceId });
          } catch {
            return { parked: true, humanTaskId, message: parkedMessage };
          }
        }
        return { humanTaskId, status: task.status, answer: task.answer ?? null };
      }
    }

    // Still pending after the grace window — park. Leave the gate pending and the
    // stage WAITING_FOR_HUMAN; the agent must stop now (run-stage re-checks the
    // gate at exit and reports WAITING_FOR_HUMAN, then a resume continues it).
    return { parked: true, humanTaskId, message: parkedMessage };
  };

  // Ask the human team one or more structured questions. Opens a pending gate,
  // mirrors a Question vertex (so the Intent page renders it), broadcasts, then
  // parks + polls (see parkAndPoll).
  const askQuestion = async ({ questions }) => {
    const humanTaskId = `q-${ids()}`;
    const questionsJson = JSON.stringify(questions);

    await store.createHumanTask({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      kind: 'question',
      questions: questionsJson,
      humanTaskId,
    });
    if (graphWriter?.recordQuestion) {
      // Best-effort graph mirror — a failed mirror must not block the question.
      try {
        await graphWriter.recordQuestion({ questionId: humanTaskId, questionsJson });
      } catch {
        /* the gate + broadcast are the source of truth */
      }
    }
    await store.appendEvent({
      executionId,
      type: 'v2.question.asked',
      stageInstanceId,
      unitSlug,
      sectionIndex,
      actor: stageInstanceId ?? 'agent',
      summary: `Agent asked ${questions.length} question(s)`,
      // Attempt-scoped like every receipt in this phase: `summaryConfirmation:
      // if-present` fires only when THIS attempt asked a question, so a rewind must
      // stop the previous attempt's question from obliging the new one.
      // A non-owner session (the ensemble's integrator) is marked so the
      // evaluator does not read its question as the stage's conditional question
      // flow: the owner's confirmation was already settled before it ran.
      detail: checkpointOwner ? { attempt } : { attempt, checkpointOwner: false },
    });
    await broadcast({
      action: 'agent.question',
      executionId,
      intentId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      humanTaskId,
      questions,
    });

    return parkAndPoll({
      humanTaskId,
      parkedMessage:
        'Question parked. STOP NOW — end your turn with no further tool calls; ' +
        'you will be resumed with the answer.',
    });
  };

  // A checkpoint gate's id is DERIVED, not random, so a container that did not
  // raise the gate can still find it: after a park the answer arrives in a fresh
  // MCP child which has no memory of a uuid. `round` distinguishes the re-asks a
  // "Request changes" loop produces.
  const checkpointTaskId = (checkpoint, round) =>
    `chk-${checkpoint}-${stageInstanceId ?? 'stage'}-${attempt}-${unitSlug ?? '-'}-${round}`;

  // The newest checkpoint gate for this (stage, attempt) and the first free round
  // after it, bounded so a pathological loop cannot scan forever.
  const latestCheckpointGate = async (checkpoint) => {
    let latest = null;
    for (let round = 0; round < CHECKPOINT_MAX_ROUNDS; round += 1) {
      const task = await store
        .getHumanTask(executionId, checkpointTaskId(checkpoint, round))
        .catch(() => null);
      if (!task) return { latest, nextRound: round };
      latest = task;
    }
    return { latest, nextRound: CHECKPOINT_MAX_ROUNDS };
  };

  // Record the authorization the human gave. Idempotent through putReceipt's
  // deterministic SK, so the same answer replayed by a resume or a redrive returns
  // the existing row instead of writing a second one.
  const recordCheckpointReceipt = async ({ spec, checkpoint, task, label }) => {
    const receipt = await store.putReceipt({
      executionId,
      kind: spec.receiptKind,
      stageInstanceId,
      attempt,
      unitSlug,
      sectionIndex,
      boundDigest: task.detail?.boundDigest ?? null,
      choice: label,
      decidedBy: task.answeredBy ?? null,
      decidedByName: task.answeredByName ?? null,
      humanTaskId: task.humanTaskId,
      detail: { checkpoint },
    });
    if (spec.receiptKind === 'summary-confirmation') activeAuthorizationId = receipt.sk;
    await store
      .appendEvent({
        executionId,
        type: spec.events.confirmed,
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: task.answeredByName || task.answeredBy || 'the human team',
        summary: `${checkpoint} authorized ("${label}")`,
        detail: { checkpoint, authorizationId: receipt.sk, attempt },
      })
      .catch(() => {});
    return receipt;
  };

  // Turn an answered gate into the agent's return value. ONLY the exact positive
  // label creates authority (upstream §1.4): the rejection re-opens the loop with
  // the human's words, and any other shape is a re-ask with no receipt — so a
  // free-text answer can never be mistaken for a confirmation.
  const resolveCheckpointAnswer = async ({ spec, checkpoint, task }) => {
    const label = chosenLabel(task.answer);
    const feedback =
      typeof task.answer === 'string'
        ? task.answer
        : (task.answer?.freeText ?? task.answer?.feedback ?? label);
    if (label === spec.approve) {
      const receipt = await recordCheckpointReceipt({ spec, checkpoint, task, label });
      return {
        checkpoint,
        decision: 'approved',
        choice: label,
        authorizationId: receipt.sk,
        humanTaskId: task.humanTaskId,
      };
    }
    if (label === spec.reject) {
      await store
        .appendEvent({
          executionId,
          type: spec.events.changesRequested,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: task.answeredByName || task.answeredBy || 'the human team',
          summary: `${checkpoint} changes requested${feedback ? `: ${String(feedback).slice(0, 240)}` : ''}`,
          detail: { checkpoint, attempt },
        })
        .catch(() => {});
      return {
        checkpoint,
        decision: 'changes-requested',
        choice: label,
        feedback: feedback ?? '',
        authorizationId: null,
        humanTaskId: task.humanTaskId,
      };
    }
    return {
      checkpoint,
      decision: 're-ask',
      choice: label,
      authorizationId: null,
      humanTaskId: task.humanTaskId,
      message:
        `The answer "${label}" is not one of the two this checkpoint accepts, so ` +
        `nothing was authorized. Raise it again and ask for exactly ` +
        `"${spec.approve}" or "${spec.reject}".`,
    };
  };

  const refuseAuthorization = async ({ checkpoint, reason, humanTaskId = null }) => {
    await store
      .appendEvent({
        executionId,
        type: 'v2.checkpoint.authorization_refused',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: 'agentcore',
        summary: `${checkpoint} authorization refused: ${reason}`,
        detail: { checkpoint, reason, attempt, humanTaskId },
      })
      .catch(() => {});
  };

  // Rehydrate the active authorization from durable state. Called once at
  // construction: a parked checkpoint is answered while this container does not
  // exist, so on the resume leg the receipt — or the answered gate that should
  // have produced one — is the ONLY record that the human authorized anything.
  // Minting it here rather than on the raise path is what makes park/resume safe.
  //
  // An EXISTING receipt is re-checked against the gate it names before it is
  // allowed to stamp anything: same digest, and a gate that still records a human.
  // Refusing is safe — the completion ladder then reports the authorization as
  // missing, which the human can waive or override at the gate, so a refusal is
  // never a dead end.
  const rehydrateAuthorizations = async () => {
    if (!policy) return null;
    for (const [checkpoint, spec] of Object.entries(CHECKPOINTS)) {
      const existing = await store
        .getReceipt(executionId, {
          kind: spec.receiptKind,
          stageInstanceId,
          attempt,
          unitSlug,
        })
        .catch(() => null);
      if (existing) {
        // Only the summary confirmation mints the stamp this bridge applies, so it
        // is the only receipt whose provenance this code can act on. A plan-approval
        // receipt is judged by the completion ladder's commit-lineage rule from the
        // row itself; refusing it here would emit a signal nothing enforces.
        if (spec.receiptKind !== 'summary-confirmation') continue;
        const source = existing.humanTaskId
          ? await store.getHumanTask(executionId, existing.humanTaskId).catch(() => null)
          : null;
        const refusal = !source
          ? `receipt ${existing.sk} names no readable gate row`
          : (authorizationRefusal(source) ??
            (String(source.detail.boundDigest) === String(existing.boundDigest ?? '')
              ? null
              : `receipt ${existing.sk} boundDigest does not match gate ${source.humanTaskId}`));
        if (refusal) {
          await refuseAuthorization({
            checkpoint,
            reason: refusal,
            humanTaskId: existing.humanTaskId ?? null,
          });
          continue;
        }
        activeAuthorizationId = existing.sk;
        continue;
      }
      const { latest } = await latestCheckpointGate(checkpoint);
      if (!latest || latest.status === 'pending') continue;
      if (chosenLabel(latest.answer) !== spec.approve) continue;
      const refusal = authorizationRefusal(latest);
      if (refusal) {
        await refuseAuthorization({
          checkpoint,
          reason: refusal,
          humanTaskId: latest.humanTaskId ?? null,
        });
        continue;
      }
      await recordCheckpointReceipt({
        spec,
        checkpoint,
        task: latest,
        label: spec.approve,
      }).catch(() => {});
    }
    return activeAuthorizationId;
  };
  const rehydrated = rehydrateAuthorizations().catch(() => null);

  // Raise one checkpoint. Everything but the payload is identical to ask_question:
  // same gate kind, same park/poll, same resume path.
  const raiseCheckpoint = async ({ checkpoint, boundTo, prompt }) => {
    const spec = CHECKPOINTS[checkpoint];
    if (!spec) throw new Error(`unknown checkpoint "${checkpoint}"`);
    await rehydrated;
    const { latest, nextRound } = await latestCheckpointGate(checkpoint);
    const existingPending = latest?.status === 'pending' ? latest : null;
    if (!existingPending && nextRound >= CHECKPOINT_MAX_ROUNDS) {
      throw new Error(
        `${checkpoint} has already been raised ${CHECKPOINT_MAX_ROUNDS} times for this ` +
          'attempt; stop calling it and finish the stage so the human can decide at the gate.',
      );
    }
    const boundDigest = sha256(
      canonicalJson({ stageInstanceId, attempt, unitSlug, checkpoint, ...boundTo }),
    );
    const humanTaskId = existingPending?.humanTaskId ?? checkpointTaskId(checkpoint, nextRound);
    let reusedPending = Boolean(existingPending);
    const pendingDigest = existingPending?.detail?.boundDigest;
    if (existingPending && pendingDigest !== boundDigest) {
      throw new Error(
        `${checkpoint} already has a pending gate for different content; wait for its answer before raising it again.`,
      );
    }
    // What the digest DOES: it records, on the gate row, a fingerprint of the exact
    // content this question showed. `rehydrateAuthorizations` checks the receipt it
    // minted still matches that row, so a receipt cannot be re-pointed at a
    // different decision. It does NOT (yet) prove the bytes a later write recorded
    // are the bytes the human saw — that comparison belongs to the completion
    // ladder's lineage rule, which matches artifact stamps against the
    // authorization, not against this digest.
    if (!existingPending) {
      const questions = [
        {
          text: `${prompt}\n\n${spec.question}`,
          type: 'single',
          options: [{ label: spec.approve }, { label: spec.reject }],
        },
      ];
      try {
        await store.createHumanTask({
          executionId,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          kind: 'question',
          questions: JSON.stringify(questions),
          detail: { checkpoint, boundDigest },
          humanTaskId,
        });
      } catch (error) {
        if (error?.name !== 'ConditionalCheckFailedException') throw error;
        const racedGate = await store.getHumanTask(executionId, humanTaskId).catch(() => null);
        if (racedGate?.status !== 'pending') throw error;
        if (racedGate.detail?.boundDigest !== boundDigest) {
          throw new Error(
            `${checkpoint} already has a pending gate for different content; wait for its answer before raising it again.`,
            { cause: error },
          );
        }
        reusedPending = true;
      }
      if (!reusedPending) {
        await store.appendEvent({
          executionId,
          type: spec.events.requested,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: stageInstanceId ?? 'agent',
          summary: `Agent raised the ${checkpoint} checkpoint`,
          detail: { checkpoint, boundDigest, attempt },
        });
        await broadcast({
          action: 'agent.question',
          executionId,
          intentId,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          humanTaskId,
          questions,
        });
      }
    }

    const outcome = await parkAndPoll({
      humanTaskId,
      parkedMessage:
        `The ${checkpoint} checkpoint is parked. STOP NOW — end your turn with no further ` +
        'tool calls; you will be resumed with the decision.',
    });
    if (outcome.parked) return outcome;
    const task = await store.getHumanTask(executionId, humanTaskId);
    return resolveCheckpointAnswer({ spec, checkpoint, task: task ?? { humanTaskId } });
  };

  const confirmSummary = ({ summary, decisions = [] }) =>
    raiseCheckpoint({
      checkpoint: 'summary-confirmation',
      boundTo: { summary, decisions },
      prompt: [
        summary,
        ...(decisions.length
          ? ['', 'Decisions I am about to commit:', ...decisions.map((item) => `- ${item}`)]
          : []),
      ].join('\n'),
    });

  const requestPlanApproval = ({ plan, testInstructions }) =>
    raiseCheckpoint({
      checkpoint: 'plan-approval',
      boundTo: { plan, testInstructions },
      prompt: [plan, '', 'How to test this once it is built:', testInstructions].join('\n'),
    });

  // Record that an artifact was written, and under whose authorization. A write
  // with NO stamp is treated by the completion ladder exactly like an unauthorized
  // one, so this is evidence, not decoration — but it must never fail the tool
  // call, because the artifact IS already written.
  const stampArtifact = async ({ artifactId, artifactType, contentHash }) => {
    if (!policy) return null;
    await rehydrated;
    const row = await store
      .appendEvent({
        executionId,
        type: 'v2.artifact.stamped',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: stageInstanceId ?? 'agent',
        summary: `Artifact ${artifactType ?? artifactId} written ${
          activeAuthorizationId ? 'under recorded authorization' : 'with no recorded authorization'
        }`,
        detail: {
          artifactId,
          artifactType: artifactType ?? null,
          contentHash,
          authorizationId: activeAuthorizationId ?? null,
        },
      })
      .catch(() => null);
    return row ? { eventId: row.eventId } : null;
  };

  // Stream a unit of agent output to the UI and persist it for reload.
  const sendOutput = async ({ content, kind = 'text' }) => {
    const row = await store.appendOutput({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      kind,
      content,
    });
    await broadcast({
      action: 'agent.output',
      executionId,
      intentId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      seq: row.seq,
      kind,
      content,
      timestamp: row.timestamp,
    });
    return { seq: row.seq, kind };
  };

  const recordProjectType = async ({ projectType }) => {
    if (stageId !== 'workspace-detection') {
      throw new Error('record_project_type is available only during workspace-detection');
    }
    if (projectType !== 'greenfield' && projectType !== 'brownfield') {
      throw new Error('projectType must be greenfield or brownfield');
    }
    await store.updateExecution({ executionId, projectType });
    await store.appendEvent({
      executionId,
      type: 'v2.workspace.classified',
      stageInstanceId,
      actor: stageInstanceId ?? 'agent',
      summary: `Workspace classified as ${projectType}`,
    });
    await broadcast({
      action: 'agent.note',
      executionId,
      intentId,
      stageInstanceId,
      noteType: 'v2.workspace.classified',
      summary: `Workspace classified as ${projectType}`,
    });
    return { projectType };
  };

  // Record a numeric metric sample (token usage, context-window %, etc.) and
  // broadcast it live so the UI can render usage in real time.
  const collectMetric = async ({ metrics }) => {
    // Stamp the trusted resolved model (from the container scope) so read-time
    // pricing needn't trust the agent bag. Null when the runtime didn't wire it.
    const row = await store.recordMetric({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      metrics,
      resolvedModel: model,
    });
    await broadcast({
      action: 'agent.metric',
      executionId,
      intentId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      metricId: row.metricId,
      metrics,
    });
    return { metricId: row.metricId };
  };

  // Append a process/audit note and broadcast it live (progress feed).
  //
  // `loopBackRecommended` is the ONE structured field on this tool:
  // a build-and-test agent that finds a code defect it must not fix itself says
  // so here, and the platform — not a prose convention — turns that into a typed
  // `v2.loopback.recommended` event the orchestrator's gate reads. The attempt is
  // stamped from the trusted container scope so the recommendation is
  // attempt-scoped like every receipt in this phase: a rewind bumps the attempt
  // and the recommendation stops applying without anything being deleted.
  // Honoured only in release mode; an unpinned run records the plain note, which
  // is what keeps its timeline byte-identical.
  const emitStageNote = async ({ summary, type = 'v2.stage.note', loopBackRecommended = null }) => {
    const row = await store.appendEvent({
      executionId,
      type,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      actor: stageInstanceId ?? 'agent',
      summary,
    });
    const reason = policy ? String(loopBackRecommended ?? '').trim() : '';
    if (reason) {
      await store
        .appendEvent({
          executionId,
          type: LOOP_BACK_RECOMMENDED_EVENT,
          stageInstanceId,
          unitSlug,
          sectionIndex,
          actor: stageInstanceId ?? 'agent',
          summary: `Agent recommends looping back to code generation: ${reason.slice(0, 300)}`,
          detail: { attempt, reason: reason.slice(0, 300) },
        })
        .catch(() => {
          /* the recommendation is advisory: a lost write withholds the OFFER, it
             never fails the tool call or the stage */
        });
    }
    await broadcast({
      action: 'agent.note',
      executionId,
      intentId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      eventId: row.eventId,
      noteType: type,
      summary,
      ...(reason ? { loopBackRecommended: true } : {}),
    });
    return { eventId: row.eventId, ...(reason ? { loopBackRecommended: true } : {}) };
  };

  const submitReview = async ({ reviewer, verdict, findings = '', round = 0 }) => {
    const normalized = String(verdict ?? '')
      .trim()
      .toUpperCase();
    if (normalized !== 'READY' && normalized !== 'NOT-READY') {
      throw new Error('submit_review verdict must be READY or NOT-READY');
    }
    const result = normalized === 'READY' ? 'PASS' : 'FAIL';
    // Identity: the TRUSTED scope identity (set by run-stage, upstream §12a's
    // identity marker enforced server-side) wins over the agent's self-report —
    // a hallucinated or omitted `reviewer` arg can no longer detach the verdict
    // row from the reviewer round that ran (latestReviewerVerdict matches on
    // sensorId `reviewer:<agent>`). The self-report is still recorded, and a
    // mismatch is flagged, so prompt-contract drift stays visible in the audit
    // trail instead of silently disappearing.
    const identity = reviewerAgent || reviewer || 'unknown';
    const reported = reviewer ?? null;
    const identityMismatch = Boolean(reviewerAgent && reported && reported !== reviewerAgent);
    const row = await store.recordSensorRun({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      sensorId: `reviewer:${identity}`,
      kind: 'reviewer',
      severity: 'advisory',
      result,
      held: false,
      detail: {
        verdict: normalized,
        findings,
        round,
        reviewer: identity,
        ...(identityMismatch ? { reportedReviewer: reported, identityMismatch: true } : {}),
      },
    });
    await store
      .appendEvent({
        executionId,
        type: normalized === 'READY' ? 'v2.review.ready' : 'v2.review.not_ready',
        stageInstanceId,
        unitSlug,
        sectionIndex,
        actor: identity,
        summary: `Reviewer ${identity} returned ${normalized}${findings ? `: ${String(findings).slice(0, 240)}` : ''}`,
      })
      .catch(() => {});
    await broadcast({
      action: 'agent.note',
      executionId,
      intentId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      noteType: normalized === 'READY' ? 'v2.review.ready' : 'v2.review.not_ready',
      summary: `Reviewer ${identity} returned ${normalized}`,
    });
    return { sensorRunId: row.sensorRunId, verdict: normalized };
  };

  const recordGraphRead = async ({ tool, bytes = 0, resultCount = null, args = {} }) => {
    if (!store.recordGraphRead) return null;
    return store.recordGraphRead({
      executionId,
      stageInstanceId,
      unitSlug,
      sectionIndex,
      tool,
      bytes,
      resultCount,
      args,
    });
  };

  return {
    askQuestion,
    confirmSummary,
    requestPlanApproval,
    stampArtifact,
    rehydrateAuthorizations,
    activeAuthorizationId: () => activeAuthorizationId,
    sendOutput,
    recordProjectType,
    collectMetric,
    emitStageNote,
    recordGraphRead,
    submitReview,
  };
};
