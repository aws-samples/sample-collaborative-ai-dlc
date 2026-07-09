import { describe, it, expect, vi } from 'vitest';
import { createDiscussionAssistStart } from '../commands/discussion-assist-start.js';

const basePayload = {
  command: 'discussion-assist-start',
  projectId: 'p1',
  intentId: 'i1',
  discussionId: 'd1',
  messageId: 'dm-12345678',
  requestId: 'assist-12345678',
  assistCommand: 'summarize',
};

describe('createDiscussionAssistStart', () => {
  it('validates the discussion assist identity and command', async () => {
    const start = createDiscussionAssistStart({ openGraph: vi.fn() });
    expect(await start({ ...basePayload, messageId: '' })).toMatchObject({
      ok: false,
      reason: 'missing_discussion_assist_identity',
    });
    expect(await start({ ...basePayload, assistCommand: 'invalid' })).toMatchObject({
      ok: false,
      reason: 'invalid_discussion_assist_command',
    });
  });

  it('accepts immediately and treats a duplicate request as idempotent while running', async () => {
    const openGraph = vi.fn(() => new Promise(() => {}));
    const start = createDiscussionAssistStart({ openGraph });

    const first = await start(basePayload);
    expect(first).toMatchObject({
      ok: true,
      accepted: true,
      requestId: 'assist-12345678',
      messageId: 'dm-12345678',
    });

    const duplicate = await start(basePayload);
    expect(duplicate).toMatchObject({
      ok: true,
      accepted: true,
      alreadyRunning: true,
      requestId: 'assist-12345678',
    });
    expect(openGraph).toHaveBeenCalledTimes(1);
  });
});
