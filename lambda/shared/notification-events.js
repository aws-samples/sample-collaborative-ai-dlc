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

const TIMEOUT_MS = 2000;
const DEFAULT_SOURCE = 'collaborative-ai-dlc';

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
 * @param {{ getClient?: () => Promise<{ client: { send: Function }, PutEventsCommand: Function }> }} [deps]
 */
export const publishNotificationEvent = async (detailType, detail, deps = {}) => {
  const bus = process.env.NOTIFICATION_EVENT_BUS;
  if (!bus) return false;
  const source = process.env.NOTIFICATION_EVENT_SOURCE || DEFAULT_SOURCE;
  try {
    const { client, PutEventsCommand } = await (deps.getClient ?? defaultClient)();
    const out = await client.send(
      new PutEventsCommand({
        Entries: [
          {
            EventBusName: bus,
            Source: source,
            DetailType: detailType,
            Detail: JSON.stringify(detail),
          },
        ],
      }),
      { abortSignal: AbortSignal.timeout(TIMEOUT_MS) },
    );
    if (out?.FailedEntryCount) {
      logger.warn('notification event rejected', {
        detailType,
        errorCode: out.Entries?.[0]?.ErrorCode,
      });
      return false;
    }
    return true;
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

export default { publishNotificationEvent, resetNotificationEventClient };
