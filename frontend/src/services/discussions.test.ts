import { describe, it, expect, vi, beforeEach } from 'vitest';

const get = vi.fn();
const post = vi.fn();
const put = vi.fn();
vi.mock('./api', () => ({
  api: {
    get: (...a: unknown[]) => get(...a),
    post: (...a: unknown[]) => post(...a),
    put: (...a: unknown[]) => put(...a),
  },
  ApiError: class ApiError extends Error {},
}));

import {
  discussionBasePath,
  discussionScopeId,
  discussionsService,
  type DiscussionScope,
} from './discussions';

const SPRINT: DiscussionScope = { kind: 'sprint', sprintId: 's1' };
const INTENT: DiscussionScope = { kind: 'intent', projectId: 'p1', intentId: 'i1' };

describe('discussion scope helpers (the path contract)', () => {
  it('discussionBasePath differs per scope kind', () => {
    expect(discussionBasePath(SPRINT)).toBe('/sprints/s1');
    expect(discussionBasePath(INTENT)).toBe('/projects/p1/intents/i1');
  });
  it('discussionScopeId returns the root id', () => {
    expect(discussionScopeId(SPRINT)).toBe('s1');
    expect(discussionScopeId(INTENT)).toBe('i1');
  });
});

describe('discussionsService routes both scopes through the base path', () => {
  beforeEach(() => {
    get.mockReset().mockResolvedValue([]);
    post.mockReset().mockResolvedValue({});
    put.mockReset().mockResolvedValue({});
  });

  it('list/getOrCreate/messages on a sprint scope', async () => {
    await discussionsService.list(SPRINT);
    expect(get).toHaveBeenCalledWith('/sprints/s1/discussions');
    await discussionsService.getOrCreate(SPRINT, { entityType: 'sprint' });
    expect(post).toHaveBeenCalledWith('/sprints/s1/discussions', { entityType: 'sprint' });
    await discussionsService.listMessages(SPRINT, 'd1', {});
    expect(get).toHaveBeenCalledWith('/sprints/s1/discussions/d1/messages');
  });

  it('list/getOrCreate/messages/redact on an intent scope', async () => {
    await discussionsService.list(INTENT);
    expect(get).toHaveBeenCalledWith('/projects/p1/intents/i1/discussions');
    await discussionsService.getOrCreate(INTENT, { entityType: 'artifact', entityId: 'a1' });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/discussions', {
      entityType: 'artifact',
      entityId: 'a1',
    });
    await discussionsService.postMessage(INTENT, 'd1', { id: 'dm-1', content: 'hi' });
    expect(post).toHaveBeenCalledWith('/projects/p1/intents/i1/discussions/d1/messages', {
      id: 'dm-1',
      content: 'hi',
    });
    await discussionsService.redact(INTENT, 'd1', 'dm-1');
    expect(post).toHaveBeenCalledWith(
      '/projects/p1/intents/i1/discussions/d1/messages/dm-1/redact',
      {},
    );
  });

  it('markRead stays available for the read-only sprint scope', async () => {
    await discussionsService.markRead(SPRINT, 'd1', {
      lastReadAt: '2026-01-01T00:00:00Z',
      lastReadMessageId: 'dm-9',
    });
    expect(put).toHaveBeenCalledWith('/sprints/s1/discussions/d1/read', {
      lastReadAt: '2026-01-01T00:00:00Z',
      lastReadMessageId: 'dm-9',
    });
  });

  it('has no assist method anymore (v1 in-thread assist was removed)', () => {
    expect('assist' in discussionsService).toBe(false);
  });
});
