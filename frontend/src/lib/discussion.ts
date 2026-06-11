import type { DiscussionMessage } from '../services/discussions';

// Pure discussion logic (plan §6/§11) — kept free of React/Yjs so it is unit
// testable. One total order everywhere: display order (createdAt, id), change
// order (updatedAt, id). Both server-assigned ISO strings; ties break on id.

export const compareByCreated = (a: DiscussionMessage, b: DiscussionMessage): number => {
  if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

export const compareByUpdated = (a: DiscussionMessage, b: DiscussionMessage): number => {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt < b.updatedAt ? -1 : 1;
  if (a.id !== b.id) return a.id < b.id ? -1 : 1;
  return 0;
};

export const sortMessages = (messages: DiscussionMessage[]): DiscussionMessage[] =>
  [...messages].sort(compareByCreated);

/**
 * Merge precedence (plan §6): entries with a newer `updatedAt` overwrite —
 * this is how redactions of already-synced messages win over the stale copy.
 * Returns the message that should be kept.
 */
export const newerOf = (
  existing: DiscussionMessage | undefined,
  incoming: DiscussionMessage,
): DiscussionMessage => {
  if (!existing) return incoming;
  return compareByUpdated(existing, incoming) < 0 ? incoming : existing;
};

/**
 * The change cursor for `?after=` delta reconciliation: the maximum
 * (updatedAt, id) over everything seen (plan §6). Returns the wire format
 * `{updatedAt},{id}` or null when nothing has been seen.
 */
export const changeCursorOf = (messages: DiscussionMessage[]): string | null => {
  let max: DiscussionMessage | null = null;
  for (const m of messages) {
    if (!max || compareByUpdated(max, m) < 0) max = m;
  }
  return max ? `${max.updatedAt},${max.id}` : null;
};

/** Display-order keyset cursor for `?before=` history paging. */
export const displayCursorOf = (m: DiscussionMessage): string => `${m.createdAt},${m.id}`;

/**
 * Client-generated message id (plan §5): `dm-{ts}-{rand}` — idempotent retry
 * key AND the Yjs map key. Server-validated against /^dm-[a-z0-9-]{8,64}$/.
 */
export const makeMessageId = (now: number = Date.now()): string =>
  `dm-${now}-${Math.random().toString(36).slice(2, 10)}`;

/**
 * First-unread divider placement (plan §9): given the sorted message count
 * and the caller's unreadCount (computed server-side against the composite
 * cursor), the divider sits before the (unreadCount)-last message. Returns
 * the index of the first unread message, or null when nothing is unread.
 */
export const firstUnreadIndex = (messageCount: number, unreadCount: number): number | null => {
  if (unreadCount <= 0 || messageCount === 0) return null;
  return Math.max(messageCount - unreadCount, 0);
};

const RELATIVE_STEPS: Array<[number, Intl.RelativeTimeFormatUnit]> = [
  [60, 'second'],
  [60, 'minute'],
  [24, 'hour'],
  [7, 'day'],
  [4.34524, 'week'],
  [12, 'month'],
  [Number.POSITIVE_INFINITY, 'year'],
];

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });

/** "5 minutes ago" style relative timestamp for message bubbles. */
export const relativeTime = (iso: string, now: number = Date.now()): string => {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return '';
  let delta = (then - now) / 1000;
  for (const [step, unit] of RELATIVE_STEPS) {
    if (Math.abs(delta) < step) return rtf.format(Math.round(delta), unit);
    delta /= step;
  }
  return '';
};

/**
 * Group consecutive messages by the same author within a short window so the
 * thread renders compact author blocks.
 */
export interface MessageGroup {
  authorId: string;
  authorName: string;
  authorType: 'user' | 'agent';
  messages: DiscussionMessage[];
}

const GROUP_WINDOW_MS = 5 * 60 * 1000;

export const groupMessages = (sorted: DiscussionMessage[]): MessageGroup[] => {
  const groups: MessageGroup[] = [];
  for (const m of sorted) {
    const last = groups[groups.length - 1];
    const lastMessage = last?.messages[last.messages.length - 1];
    if (
      last &&
      lastMessage &&
      last.authorId === m.authorId &&
      last.authorType === m.authorType &&
      Date.parse(m.createdAt) - Date.parse(lastMessage.createdAt) < GROUP_WINDOW_MS
    ) {
      last.messages.push(m);
    } else {
      groups.push({
        authorId: m.authorId,
        authorName: m.authorName,
        authorType: m.authorType,
        messages: [m],
      });
    }
  }
  return groups;
};
