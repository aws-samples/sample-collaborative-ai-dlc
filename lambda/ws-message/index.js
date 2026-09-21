// -----------------------------------------------------------------------------
// WebSocket default/catch-all handler — defensive no-op.
//
// All realtime events are SERVER-ORIGIN: `question.answered` is emitted by the
// questions lambda (PUT) and the agents lambda (answer endpoint), and
// `sprint.phaseChanged` by the sprints lambda (phase update) — see
// lambda/shared/ws-fanout.js. The frontend never client-broadcasts, so this
// lambda exists ONLY to absorb the $default / sync / notification routes and
// drop whatever a client sends. Connected clients cannot inject events.
//
// Earlier revisions carried a client-event allowlist plus sender-row lookup and
// fan-out machinery for client-origin broadcast. That path was permanently off
// (the allowlist was empty) and had no frontend callers, so it has been removed.
// Recover it from git history if client-origin broadcast is ever revived.
// -----------------------------------------------------------------------------
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'ws-message' } });

export const handler = async (event, context) => {
  if (context) logger.addContext(context);
  const connectionId = event.requestContext.connectionId;
  const { action } = JSON.parse(event.body || '{}');
  logger.warn('Dropped client message', { action, connectionId });
  return { statusCode: 200 };
};
