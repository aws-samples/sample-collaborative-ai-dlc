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
  | 'question'
  | 'requirement'
  | 'userstory'
  | 'task'
  | 'review'
  | 'generalinfo';

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

export type AssistCommand = 'suggest-answer' | 'summarize' | 'explain' | 'custom';

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
  list: (sprintId: string) => api.get<Discussion[]>(`/sprints/${sprintId}/discussions`),

  getOrCreate: (
    sprintId: string,
    input: { entityType: DiscussionEntityType; entityId?: string; entityTitle?: string },
  ) => withTransparentRetry(() => api.post<Discussion>(`/sprints/${sprintId}/discussions`, input)),

  listMessages: (
    sprintId: string,
    discussionId: string,
    opts: { before?: string; after?: string; limit?: number } = {},
  ) => {
    const params = new URLSearchParams();
    if (opts.before) params.set('before', opts.before);
    if (opts.after) params.set('after', opts.after);
    if (opts.limit) params.set('limit', String(opts.limit));
    const qs = params.toString();
    return api.get<MessagePage>(
      `/sprints/${sprintId}/discussions/${discussionId}/messages${qs ? `?${qs}` : ''}`,
    );
  },

  postMessage: (
    sprintId: string,
    discussionId: string,
    input: { id: string; content: string; mentions?: string[] },
  ) =>
    withTransparentRetry(() =>
      api.post<DiscussionMessage>(
        `/sprints/${sprintId}/discussions/${discussionId}/messages`,
        input,
      ),
    ),

  update: (
    sprintId: string,
    discussionId: string,
    input: { status: 'open' | 'resolved'; resolutionSummary?: string; outcomeMessageId?: string },
  ) => api.put<Discussion>(`/sprints/${sprintId}/discussions/${discussionId}`, input),

  redact: (sprintId: string, discussionId: string, messageId: string) =>
    api.post<DiscussionMessage>(
      `/sprints/${sprintId}/discussions/${discussionId}/messages/${messageId}/redact`,
      {},
    ),

  markRead: (
    sprintId: string,
    discussionId: string,
    input: { lastReadAt: string; lastReadMessageId: string },
  ) =>
    api.put<{ lastReadAt: string; lastReadMessageId: string }>(
      `/sprints/${sprintId}/discussions/${discussionId}/read`,
      input,
    ),

  search: (
    sprintId: string,
    opts: { q: string; author?: string; status?: string; entityType?: string; limit?: number },
  ) => {
    const params = new URLSearchParams({ q: opts.q });
    if (opts.author) params.set('author', opts.author);
    if (opts.status) params.set('status', opts.status);
    if (opts.entityType) params.set('entityType', opts.entityType);
    if (opts.limit) params.set('limit', String(opts.limit));
    return api.get<{ results: SearchResult[] }>(
      `/sprints/${sprintId}/discussions/search?${params.toString()}`,
    );
  },

  /**
   * Invoke an in-thread agent assist. Returns the executionId
   * used to correlate the agent.* stream. 409 {reason:'assist_in_progress'}
   * and 400 cli_unavailable are NOT retried — the UI surfaces them.
   */
  assist: (
    sprintId: string,
    discussionId: string,
    input: { command: AssistCommand; instruction?: string },
  ) =>
    api.post<{ assistId: string }>(
      `/sprints/${sprintId}/discussions/${discussionId}/assist`,
      input,
    ),
};
