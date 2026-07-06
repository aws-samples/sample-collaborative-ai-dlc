import { api, ApiError } from './api';

// Discussions service — typed client for lambda/discussions.
//
// Concurrency contract: the backend serializes thread creation and message
// append through DynamoDB guards and answers `409 {reason, retryAfter}` while
// a competing writer is in flight. Those 409s are TRANSPARENT-retry signals
// (same request, same id), handled here so callers never see them.

export type DiscussionEntityType =
  | 'sprint'
  | 'inception'
  // `question` is valid in BOTH scopes: v1 sprint questions and v2 question
  // gates (the Neptune Question mirror of a HUMAN# gate).
  | 'question'
  | 'requirement'
  | 'userstory'
  | 'task'
  | 'review'
  | 'generalinfo'
  // v2 intent-scoped anchors.
  | 'intent'
  | 'artifact';

// A discussion lives under a scope root: a v1 sprint or a v2 intent. The scope
// decides the REST base path; the intent path is project-scoped.
//
// v1 sprint discussions are READ-ONLY: the backend keeps list/messages/search
// + the read-state PUT, but the write routes (thread create, post, resolve,
// redact) only exist for the intent scope.
export type DiscussionScope =
  | { kind: 'sprint'; sprintId: string }
  | { kind: 'intent'; projectId: string; intentId: string };

export const discussionBasePath = (scope: DiscussionScope): string =>
  scope.kind === 'intent'
    ? `/projects/${scope.projectId}/intents/${scope.intentId}`
    : `/sprints/${scope.sprintId}`;

// The scope root id (sprintId | intentId) — used as the realtime/channel key.
export const discussionScopeId = (scope: DiscussionScope): string =>
  scope.kind === 'intent' ? scope.intentId : scope.sprintId;

export interface Discussion {
  id: string;
  title: string | null;
  entityType: DiscussionEntityType;
  entityId: string;
  entityTitle: string;
  sprintId: string;
  status: 'open' | 'resolved';
  resolvedBy?: string;
  resolvedByName?: string;
  resolvedAt?: string;
  resolutionSummary?: string;
  outcomeMessageId?: string;
  createdAt: string;
  createdBy: string;
  createdByName: string;
  lastMessageAt: string;
  messageCount?: number;
  unreadCount?: number;
}

export interface DiscussionMessage {
  id: string;
  content: string;
  authorId: string;
  authorName: string;
  authorType: 'user' | 'agent';
  command?: string;
  requestedBy?: string;
  requestedByName?: string;
  mentions: string[];
  redacted?: boolean;
  redactedBy?: string;
  redactedByName?: string;
  redactedAt?: string;
  createdAt: string;
  updatedAt: string;
  discussionId: string;
  sprintId: string;
}

export interface MessagePage {
  messages: DiscussionMessage[];
  hasMore: boolean;
}

export interface SearchResult {
  discussion: Discussion;
  message?: DiscussionMessage;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Retry the SAME request while the backend reports a competing writer
// (creation_in_progress / message_in_progress).
const RETRYABLE_REASONS = ['creation_in_progress', 'message_in_progress'];
const MAX_TRANSPARENT_RETRIES = 4;

async function withTransparentRetry<T>(fn: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const reason = err instanceof ApiError ? (err.body?.reason as string) : undefined;
      const retryAfter = err instanceof ApiError ? Number(err.body?.retryAfter) || 1 : 1;
      if (
        err instanceof ApiError &&
        err.status === 409 &&
        reason &&
        RETRYABLE_REASONS.includes(reason) &&
        attempt < MAX_TRANSPARENT_RETRIES
      ) {
        await sleep(retryAfter * 1000);
        continue;
      }
      throw err;
    }
  }
}

export const discussionsService = {
  list: (scope: DiscussionScope) =>
    api.get<Discussion[]>(`${discussionBasePath(scope)}/discussions`),

  getOrCreate: (
    scope: DiscussionScope,
    input: { entityType: DiscussionEntityType; entityId?: string; entityTitle?: string },
  ) =>
    withTransparentRetry(() =>
      api.post<Discussion>(`${discussionBasePath(scope)}/discussions`, input),
    ),

  listMessages: (
    scope: DiscussionScope,
    discussionId: string,
    opts: { before?: string; after?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    if (opts.after) params.set('after', opts.after);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return api.get<MessagePage>(
      `${discussionBasePath(scope)}/discussions/${discussionId}/messages${qs ? `?${qs}` : ''}`,
    );
  },

  postMessage: (
    scope: DiscussionScope,
    discussionId: string,
    input: { id: string; content: string; mentions?: string[] },
  ) =>
    withTransparentRetry(() =>
      api.post<DiscussionMessage>(
        `${discussionBasePath(scope)}/discussions/${discussionId}/messages`,
        input,
      ),
    ),

  update: (
    scope: DiscussionScope,
    discussionId: string,
    input: { status: 'open' | 'resolved'; resolutionSummary?: string; outcomeMessageId?: string },
  ) => api.put<Discussion>(`${discussionBasePath(scope)}/discussions/${discussionId}`, input),

  redact: (scope: DiscussionScope, discussionId: string, messageId: string) =>
    api.post<DiscussionMessage>(
      `${discussionBasePath(scope)}/discussions/${discussionId}/messages/${messageId}/redact`,
      {},
    ),

  markRead: (
    scope: DiscussionScope,
    discussionId: string,
    input: { lastReadAt: string; lastReadMessageId: string },
  ) =>
    api.put<{ lastReadAt: string; lastReadMessageId: string }>(
      `${discussionBasePath(scope)}/discussions/${discussionId}/read`,
      input,
    ),

  search: (
    scope: DiscussionScope,
    opts: { q: string; author?: string; status?: string; entityType?: string; limit?: number },
  ) => {
    const params = new URLSearchParams({ q: opts.q });
    if (opts.author) params.set('author', opts.author);
    if (opts.status) params.set('status', opts.status);
    if (opts.entityType) params.set('entityType', opts.entityType);
    if (opts.limit) params.set('limit', String(opts.limit));
    return api.get<{ results: SearchResult[] }>(
      `${discussionBasePath(scope)}/discussions/search?${params.toString()}`,
    );
  },
};
