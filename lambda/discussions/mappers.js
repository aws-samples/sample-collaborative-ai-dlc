// lambda/discussions — pure helpers and Neptune→DTO mappers. No I/O, so these
// are trivially unit-testable.

import { createHash } from 'node:crypto';
import { UNREAD_CAP } from './constants.js';

export const nowSeconds = () => Math.floor(Date.now() / 1000);
export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const isConditionalCheckFailed = (err) =>
  err?.name === 'ConditionalCheckFailedException' || err?.name === 'TransactionCanceledException';

// Caller identity comes from the Cognito User Pools authorizer — clients
// cannot spoof it.
export const getCaller = (event) => {
  const claims = event?.requestContext?.authorizer?.claims || {};
  return {
    sub: claims.sub || '',
    displayName: claims['custom:display_name'] || claims.email || '',
  };
};

export const getVal = (v, key) => {
  const raw = v instanceof Map ? v.get(key) : v?.[key];
  if (Array.isArray(raw)) return raw[0] ?? '';
  return raw ?? '';
};

export const parseJsonArray = (raw) => {
  try {
    const parsed = JSON.parse(raw || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};

export const mapDiscussion = (v, messageCount = undefined) => ({
  id: getVal(v, 'id'),
  title: getVal(v, 'title') || null,
  entityType: getVal(v, 'entity_type'),
  entityId: getVal(v, 'entity_id'),
  entityTitle: getVal(v, 'entity_title'),
  sprintId: getVal(v, 'sprint_id') || getVal(v, 'intent_id'),
  status: getVal(v, 'status') || 'open',
  resolvedBy: getVal(v, 'resolved_by') || undefined,
  resolvedByName: getVal(v, 'resolved_by_name') || undefined,
  resolvedAt: getVal(v, 'resolved_at') || undefined,
  resolutionSummary: getVal(v, 'resolution_summary') || undefined,
  outcomeMessageId: getVal(v, 'outcome_message_id') || undefined,
  createdAt: getVal(v, 'created_at'),
  createdBy: getVal(v, 'created_by'),
  createdByName: getVal(v, 'created_by_name'),
  lastMessageAt: getVal(v, 'last_message_at'),
  ...(messageCount !== undefined ? { messageCount: Number(messageCount) } : {}),
});

export const mapMessage = (v) => ({
  id: getVal(v, 'id'),
  content: getVal(v, 'content'),
  authorId: getVal(v, 'author_id'),
  authorName: getVal(v, 'author_name'),
  authorType: getVal(v, 'author_type') || 'user',
  requestId: getVal(v, 'request_id') || undefined,
  command: getVal(v, 'command') || undefined,
  requestedBy: getVal(v, 'requested_by') || undefined,
  requestedByName: getVal(v, 'requested_by_name') || undefined,
  assistStatus: getVal(v, 'assist_status') || undefined,
  mentions: parseJsonArray(getVal(v, 'mentions')),
  redacted: getVal(v, 'redacted') === 'true' || getVal(v, 'redacted') === true,
  redactedBy: getVal(v, 'redacted_by') || undefined,
  redactedByName: getVal(v, 'redacted_by_name') || undefined,
  redactedAt: getVal(v, 'redacted_at') || undefined,
  createdAt: getVal(v, 'created_at'),
  updatedAt: getVal(v, 'updated_at'),
  discussionId: getVal(v, 'discussion_id'),
  sprintId: getVal(v, 'sprint_id') || getVal(v, 'intent_id'),
});

// One total order everywhere: display order (createdAt, id),
// change order (updatedAt, id). Both server-assigned ISO strings.
export const compareBy = (tsKey) => (a, b) => {
  if (a[tsKey] !== b[tsKey]) return a[tsKey] < b[tsKey] ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

// Canonical idempotency hash over the NORMALIZED full append payload —
// not content alone, because mentions affect persisted data and
// notifications.
export const canonicalMentions = (mentions) => [...new Set(mentions)].toSorted();
export const payloadHashOf = (content, mentions) =>
  createHash('sha256')
    .update(JSON.stringify({ content, mentions: canonicalMentions(mentions) }))
    .digest('hex');

// unread = count(created_at > lastReadAt) + count(created_at == lastReadAt
// && id > lastReadMessageId) — one composite comparison. No
// cursor → everything is unread. Capped for badge display.
export const countUnread = (messageKeys, cursor) => {
  let unread = 0;
  for (const key of messageKeys) {
    if (
      !cursor ||
      key.createdAt > cursor.lastReadAt ||
      (key.createdAt === cursor.lastReadAt && key.id > cursor.lastReadMessageId)
    ) {
      unread++;
      if (unread >= UNREAD_CAP) return UNREAD_CAP;
    }
  }
  return unread;
};

export const parseCursor = (raw) => {
  if (!raw) return null;
  const idx = raw.indexOf(',');
  if (idx <= 0 || idx === raw.length - 1) return undefined; // malformed
  return { ts: raw.slice(0, idx), id: raw.slice(idx + 1) };
};
