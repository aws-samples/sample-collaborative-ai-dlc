// Process bridge for the MCP server's collaboration/process tools.
//
// Business writes go to Neptune via graph-writer; PROCESS writes go to the v2
// DynamoDB process table + the realtime websocket here:
//   - ask_question     opens a pending HUMAN# gate, mirrors a Question vertex,
//                      broadcasts it, then BLOCKS (polls DDB) until answered.
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

export const createProcessBridge = ({
  store,
  graphWriter = null,
  broadcast = async () => {},
  scope = {},
  pollIntervalMs = DEFAULT_POLL_MS,
  sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
  ids = randomUUID,
} = {}) => {
  if (!store) throw new Error('createProcessBridge requires a process store');
  if (!scope.executionId) throw new Error('createProcessBridge requires scope.executionId');
  const { executionId, intentId = null, stageInstanceId = null } = scope;

  // Ask the human team one or more structured questions. Opens a pending gate,
  // mirrors a Question vertex (so the Intent page renders it), broadcasts, parks
  // the execution as WAITING, then polls the gate until it is answered. Returns
  // the structured answer payload to the agent.
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
    await store.updateExecution({ executionId, pendingHumanTaskId: humanTaskId });
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

    // Block until answered. The future resume lambda answers the gate (CAS on
    // pending); we poll the record and return its structured answer.
    for (;;) {
      await sleep(pollIntervalMs);
      const task = await store.getHumanTask(executionId, humanTaskId);
      if (task && task.status !== 'pending') {
        await store.updateExecution({ executionId, pendingHumanTaskId: null });
        return { humanTaskId, status: task.status, answer: task.answer ?? null };
      }
    }
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
