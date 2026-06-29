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

import { randomUUID } from 'node:crypto';

const DEFAULT_POLL_MS = 3000;
// How long ask_question waits inline before PARKING. A near-instant answer still
// returns inline (today's fast-path UX); past the grace window the question parks
// so the CLI exits and the session can go idle (see docs/v2-resume.md).
const DEFAULT_PARK_GRACE_MS = 12000;

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
  const { executionId, intentId = null, stageInstanceId = null } = scope;

  // Ask the human team one or more structured questions. Opens a pending gate,
  // mirrors a Question vertex (so the Intent page renders it), broadcasts, and
  // parks the stage/execution as WAITING. Then a BOUNDED grace poll: if the human
  // answers within the window, return the answer inline as before; otherwise
  // return a parked sentinel so the agent stops and the CLI exits (the resume
  // lambda re-invokes run-stage with the answer). Keeping the wait bounded is what
  // lets /ping drop to Healthy and the session go idle.
  const askQuestion = async ({ questions }) => {
    const humanTaskId = `q-${ids()}`;
    const questionsJson = JSON.stringify(questions);

    await store.createHumanTask({
      executionId,
      stageInstanceId,
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
    // Park the stage + execution as WAITING and record the pending gate. The
    // stage row stays WAITING_FOR_HUMAN until run-stage resumes (or succeeds).
    await store.updateExecution({
      executionId,
      status: 'WAITING',
      pendingHumanTaskId: humanTaskId,
    });
    if (stageInstanceId) {
      await store
        .updateStageState({ executionId, stageInstanceId, state: 'WAITING_FOR_HUMAN' })
        .catch(() => {});
    }
    await store.appendEvent({
      executionId,
      type: 'v2.question.asked',
      stageInstanceId,
      actor: stageInstanceId ?? 'agent',
      summary: `Agent asked ${questions.length} question(s)`,
    });
    await broadcast({
      action: 'agent.question',
      executionId,
      intentId,
      humanTaskId,
      questions,
    });

    // Bounded grace poll. The resume lambda answers the gate (CAS on pending). If
    // it lands within the grace window, return inline (restore RUNNING); otherwise
    // PARK — return a sentinel telling the agent to stop so the CLI exits cleanly.
    const maxPolls = Math.max(0, Math.floor(parkGraceMs / pollIntervalMs));
    for (let i = 0; i < maxPolls; i += 1) {
      await sleep(pollIntervalMs);
      const task = await store.getHumanTask(executionId, humanTaskId);
      if (task && task.status !== 'pending') {
        // Answered in time: clear the gate, un-park, and return the answer as before.
        await store.updateExecution({
          executionId,
          status: 'RUNNING',
          pendingHumanTaskId: null,
        });
        if (stageInstanceId) {
          await store
            .updateStageState({ executionId, stageInstanceId, state: 'RUNNING' })
            .catch(() => {});
        }
        return { humanTaskId, status: task.status, answer: task.answer ?? null };
      }
    }

    // Still pending after the grace window — park. Leave the gate pending and the
    // stage WAITING_FOR_HUMAN; the agent must stop now (run-stage re-checks the
    // gate at exit and reports WAITING_FOR_HUMAN, then a resume continues it).
    return {
      parked: true,
      humanTaskId,
      message:
        'Question parked. STOP NOW — end your turn with no further tool calls; ' +
        'you will be resumed with the answer.',
    };
  };

  // Stream a unit of agent output to the UI and persist it for reload.
  const sendOutput = async ({ content, kind = 'text' }) => {
    const row = await store.appendOutput({ executionId, stageInstanceId, kind, content });
    await broadcast({
      action: 'agent.output',
      executionId,
      intentId,
      stageInstanceId,
      seq: row.seq,
      kind,
      content,
    });
    return { seq: row.seq, kind };
  };

  // Record a numeric metric sample (token usage, context-window %, etc.) and
  // broadcast it live so the UI can render usage in real time.
  const collectMetric = async ({ metrics }) => {
    const row = await store.recordMetric({ executionId, stageInstanceId, metrics });
    await broadcast({
      action: 'agent.metric',
      executionId,
      intentId,
      stageInstanceId,
      metricId: row.metricId,
      metrics,
    });
    return { metricId: row.metricId };
  };

  // Append a process/audit note and broadcast it live (progress feed).
  const emitStageNote = async ({ summary, type = 'v2.stage.note' }) => {
    const row = await store.appendEvent({
      executionId,
      type,
      stageInstanceId,
      actor: stageInstanceId ?? 'agent',
      summary,
    });
    await broadcast({
      action: 'agent.note',
      executionId,
      intentId,
      stageInstanceId,
      eventId: row.eventId,
      noteType: type,
      summary,
    });
    return { eventId: row.eventId };
  };

  return { askQuestion, sendOutput, collectMetric, emitStageNote };
};
