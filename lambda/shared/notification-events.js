// Outbound notification events: a best-effort feed of platform activity to an
// EventBridge bus, for integrations such as chat notifications.
//
// Configured by NOTIFICATION_EVENT_BUS (unset: do nothing, and never load the
// EventBridge client) and NOTIFICATION_EVENT_SOURCE. publishNotificationEvent
// never throws and never delays the caller by more than TIMEOUT_MS: a missing
// bus, a missing permission or an EventBridge outage only logs a warning.
//
// Event types and their detail fields are documented in
// docs/using-the-platform/notification-events.md.

import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'notification-events' } });

// Every event's detail.schemaVersion. Bumped only for a breaking change.
export const NOTIFICATION_EVENT_SCHEMA_VERSION = 1;

const TIMEOUT_MS = 2000;
// Share of the deadline notifyGatePending gives optional gate/META reads.
const ENRICH_MS = 1000;
const DEFAULT_SOURCE = 'collaborative-ai-dlc';

// Settle with `promise`, or with `fallback` once `signal` aborts.
const untilAborted = (promise, signal, fallback) => {
  if (signal.aborted) return Promise.resolve(fallback);
  let onAbort;
  const aborted = new Promise((resolve) => {
    onAbort = () => resolve(fallback);
    signal.addEventListener('abort', onAbort, { once: true });
  });
  return Promise.race([promise, aborted]).finally(() =>
    signal.removeEventListener('abort', onAbort),
  );
};

let clientPromise;
const defaultClient = () => {
  clientPromise ??= import('@aws-sdk/client-eventbridge').then(
    ({ EventBridgeClient, PutEventsCommand }) => ({
      client: new EventBridgeClient({ maxAttempts: 2 }),
      PutEventsCommand,
    }),
  );
  return clientPromise;
};

/**
 * Publish one notification event. Resolves to true when EventBridge accepted
 * it, false when publishing is off or failed.
 *
 * @param {string} detailType e.g. 'discussion.message'
 * @param {object} detail JSON-serialisable event detail
 * @param {{ getClient?: () => Promise<{ client: { send: Function }, PutEventsCommand: Function }>,
 *   signal?: AbortSignal }} [deps] `signal` replaces the default two-second deadline
 */
export const publishNotificationEvent = async (detailType, detail, deps = {}) => {
  const bus = process.env.NOTIFICATION_EVENT_BUS;
  if (!bus) return false;
  const source = process.env.NOTIFICATION_EVENT_SOURCE || DEFAULT_SOURCE;
  const signal = deps.signal ?? AbortSignal.timeout(TIMEOUT_MS);
  const put = async () => {
    const { client, PutEventsCommand } = await (deps.getClient ?? defaultClient)();
    const out = await client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: bus,
            Source: source,
            DetailType: detailType,
            Detail: JSON.stringify({ schemaVersion: NOTIFICATION_EVENT_SCHEMA_VERSION, ...detail }),
          },
        ],
      }),
      { abortSignal: signal },
    );
    if (out?.FailedEntryCount) {
      logger.warn('notification event rejected', {
        detailType,
        errorCode: out.Entries?.[0]?.ErrorCode,
      });
      return false;
    }
    return true;
  };
  try {
    // The deadline also covers loading the client.
    const ok = signal.aborted ? null : await untilAborted(put(), signal, null);
    if (ok === null) {
      logger.warn('notification event publish failed', { detailType, error: 'TimeoutError' });
      return false;
    }
    return ok;
  } catch (err) {
    logger.warn('notification event publish failed', {
      detailType,
      error: err?.name || String(err),
    });
    return false;
  }
};

export const resetNotificationEventClient = () => {
  clientPromise = undefined;
};

const PROMPT_CHARS = 1000;
const TITLE_CHARS = 200;

const clip = (text, limit) =>
  typeof text === 'string' && text.trim() ? text.trim().slice(0, limit) : null;

// A gate's question text. Engine gates carry `prompt`; agent questions and
// checkpoint confirmations carry a `questions` JSON array instead.
export const gatePromptText = (gate) => {
  const prompt = clip(gate?.prompt, PROMPT_CHARS);
  if (prompt) return prompt;
  let questions = gate?.questions;
  if (typeof questions === 'string') {
    try {
      questions = JSON.parse(questions);
    } catch {
      return null;
    }
  }
  const first = Array.isArray(questions) ? questions[0] : null;
  return clip(typeof first === 'string' ? first : (first?.text ?? first?.question), PROMPT_CHARS);
};

// What a gate needs from a human. A checkpoint confirmation is a `question`
// row asking to approve a plan or summary, so it is an approval.
export const gateNeed = (gate) =>
  gate?.kind === 'question' && !gate?.detail?.checkpoint ? 'answer' : 'approval';

// The gate.pending detail.
export const buildGatePending = ({
  gate,
  meta,
  projectId,
  intentId,
  executionId,
  humanTaskId,
  stage,
}) => ({
  eventId: humanTaskId,
  projectId,
  intentId,
  executionId,
  humanTaskId,
  need: gateNeed(gate),
  kind: gate?.kind ?? null,
  stage: stage ?? null,
  intentTitle: clip(meta?.title, TITLE_CHARS),
  startedBy: meta?.startedBy ?? null,
  prompt: gatePromptText(gate),
});

/**
 * Publish gate.pending for a gate waiting on a human. Reads the gate row and
 * execution META only when not passed in, and only with a bus configured.
 * The reads and the publish share one deadline, so the caller is never held
 * longer than a plain publish; a slow read is dropped and its fields go out
 * as null. Never throws.
 *
 * @param {{ getHumanTask: Function, getExecution: Function }} store
 * @param {{ gate?: object, meta?: object, projectId: string, intentId: string,
 *   executionId: string, humanTaskId: string, stage?: string|null }} args
 * @param {object} [deps] passed to publishNotificationEvent; `signal` replaces
 *   the overall deadline, `enrichSignal` the deadline for the reads
 */
export const notifyGatePending = async (store, { gate, meta, ...ids }, deps = {}) => {
  if (!process.env.NOTIFICATION_EVENT_BUS) return false;
  const signal = deps.signal ?? AbortSignal.timeout(TIMEOUT_MS);
  const enrichSignal = AbortSignal.any([
    signal,
    deps.enrichSignal ?? AbortSignal.timeout(ENRICH_MS),
  ]);
  try {
    const read = async (row, fn) => {
      if (row) return row;
      try {
        return await untilAborted(Promise.resolve().then(fn), enrichSignal, null);
      } catch {
        return null;
      }
    };
    const [gateRow, metaRow] = await Promise.all([
      read(gate, () => store.getHumanTask(ids.executionId, ids.humanTaskId)),
      read(meta, () => store.getExecution(ids.executionId)),
    ]);
    return await publishNotificationEvent(
      'gate.pending',
      buildGatePending({ ...ids, gate: gateRow, meta: metaRow }),
      { ...deps, signal },
    );
  } catch (err) {
    logger.warn('gate notification failed', { error: err?.name || String(err) });
    return false;
  }
};

export default {
  publishNotificationEvent,
  resetNotificationEventClient,
  notifyGatePending,
};
