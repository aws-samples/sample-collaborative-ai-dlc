// lambda/discussions — scoped discussion threads (router).
//
// Threads live under a SCOPE root — a v1 Sprint (`/sprints/{sprintId}/…`) or a
// v2 Intent (`/projects/{projectId}/intents/{intentId}/…`). The handlers resolve
// the scope from the path parameters (see scope.js); routing here keys off the
// path SUFFIX, so it is scope-agnostic. The discussion REST API:
//   GET  …/discussions                          list + messageCount + unreadCount
//   POST …/discussions                          atomic get-or-create (creation guard)
//   GET  …/discussions/{discussionId}/messages  keyset pagination + change delta
//   POST …/discussions/{discussionId}/messages  append via stateful message guard
//   PUT  …/discussions/{discussionId}           resolve / reopen + summary + outcome
//   POST …/messages/{messageId}/redact          admin/owner moderation
//   PUT  …/discussions/{discussionId}/read      composite read cursor
//   GET  …/discussions/search                   bounded scope search
//   + per-user mention notifications and author read-cursor auto-advance on append
//
// Durability model (server-first): REST persists to Neptune (source of truth),
// then THIS lambda fans out the full payload over the app WebSocket. Yjs is a
// live-sync optimization handled entirely client-side.
//
// Concurrency model: Neptune does not unique-constrain the `id` property,
// so thread creation and message append are serialized through DynamoDB
// conditional writes in the `discussion-locks` table. Lazy DynamoDB TTL is
// never trusted — every condition that cares about expiry checks
// `expiresAt < :now` explicitly.
//
// The implementation is split across sibling modules for readability:
//   constants.js    — literals + the load-time takeover-safety invariant
//   clients.js      — shared Neptune (query/close) + AWS SDK clients
//   mappers.js      — pure helpers and Neptune→DTO mappers
//   data-access.js  — Neptune graph + DynamoDB reads/writes
//   services.js     — authorization, WebSocket fan-out, secret resolution
//   handlers.js     — one HTTP handler per route
// This file is just the dispatcher.

import { buildResponse } from '../shared/response.js';
// Importing clients.js constructs the shared Neptune connection; importing
// constants.js asserts the takeover-safety invariant at module load.
import './constants.js';
import { close } from './clients.js';
import {
  issueRealtimeToken,
  listDiscussions,
  getOrCreateDiscussion,
  listMessages,
  postMessage,
  assistDiscussion,
  updateDiscussion,
  redactMessage,
  markRead,
  searchDiscussions,
} from './handlers.js';

// Exported for test teardown only — production reuses the connection.
export { close };

export const handler = async (event) => {
  const res = buildResponse(event);
  if (event.httpMethod === 'OPTIONS') return res(200, {});

  try {
    const path = event.resource || event.path || '';
    const method = event.httpMethod;

    if (method === 'POST' && path.endsWith('/realtime-token')) {
      return await issueRealtimeToken(event, res);
    }
    if (method === 'GET' && path.endsWith('/discussions/search')) {
      return await searchDiscussions(event, res);
    }
    if (path.endsWith('/discussions')) {
      if (method === 'GET') return await listDiscussions(event, res);
      if (method === 'POST') return await getOrCreateDiscussion(event, res);
    }
    if (path.endsWith('/messages')) {
      if (method === 'GET') return await listMessages(event, res);
      if (method === 'POST') return await postMessage(event, res);
    }
    if (method === 'POST' && path.endsWith('/assist')) {
      return await assistDiscussion(event, res);
    }
    if (method === 'PUT' && path.endsWith('/read')) {
      return await markRead(event, res);
    }
    if (method === 'POST' && path.endsWith('/redact')) {
      return await redactMessage(event, res);
    }
    if (method === 'PUT' && path.endsWith('/{discussionId}')) {
      return await updateDiscussion(event, res);
    }

    return res(404, { error: 'Not found' });
  } catch {
    console.error('discussions handler error');
    return res(500, { error: 'Internal server error' });
  }
};
