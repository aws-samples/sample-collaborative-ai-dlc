import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';

const SENDER = 'sender-conn';
const REGISTERED_DOC = 'sprint:0f8fad5b-d9cb-469f-a165-70867728950e';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const makeEvent = (body, connectionId = SENDER) => ({
  requestContext: { connectionId },
  body: JSON.stringify(body),
});

// -----------------------------------------------------------------------------
// The ws-message lambda is a defensive no-op catch-all. All realtime events are
// server-origin (lambda/shared/ws-fanout.js, emitted from the questions/agents/
// sprints lambdas); the frontend never client-broadcasts. This handler exists
// only to absorb the $default / sync / notification routes and drop whatever a
// client sends, returning 200 so API Gateway closes the frame cleanly.
// -----------------------------------------------------------------------------
describe('ws-message handler (defensive no-op)', () => {
  beforeEach(() => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('handles empty event body gracefully', async () => {
    const handler = await loadHandler();
    const res = await handler({ requestContext: { connectionId: 'conn-1' }, body: null });
    expect(res).toEqual({ statusCode: 200 });
  });

  it('throws on malformed JSON in event.body', async () => {
    const handler = await loadHandler();
    await expect(
      handler({ requestContext: { connectionId: 'conn-1' }, body: 'not valid json{' }),
    ).rejects.toThrow();
  });

  it.each([
    // Formerly-allowlisted reload hints — now server-origin only.
    ['question.answered', { action: 'question.answered', sprintId: 's-1', questionId: 'q-1' }],
    ['sprint.phaseChanged', { action: 'sprint.phaseChanged', sprintId: 's-1' }],
    // The legacy client-broadcast envelope.
    [
      'broadcastToDocument',
      {
        action: 'broadcastToDocument',
        documentId: REGISTERED_DOC,
        data: { action: 'discussion.message', message: { content: 'spoofed' } },
      },
    ],
    // Removed legacy actions.
    ['broadcast (scan-all)', { action: 'broadcast', data: { text: 'hi' } }],
    ['notification', { action: 'notification', data: { userId: 'victim', text: 'spoofed' } }],
    // Unknown / malformed.
    ['unknown', { action: 'unknown' }],
    ['missing action', { foo: 'bar' }],
  ])('drops %s and returns 200', async (_label, body) => {
    const handler = await loadHandler();
    const res = await handler(makeEvent(body));
    expect(res).toEqual({ statusCode: 200 });
    expect(console.warn).toHaveBeenCalledTimes(1);
  });
});
