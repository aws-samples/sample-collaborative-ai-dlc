import { describe, expect, it, vi } from 'vitest';
import { createKiroAcpTurn, kiroAssistantHash } from '../native/kiro-acp-turn.js';
import { kiroPromptHash } from '../native/kiro-prompt.js';

const firstPrompt = '/aidlc poc Ask me for the page title.';
const expandedPrompt =
  'AI-DLC skill\nRun poc Ask me for the page title.\nKeep the user in control.';
const options = {
  project: '/tmp/native-probe',
  prompt: firstPrompt,
  model: 'auto',
  expectedUserPromptSha256: kiroPromptHash(expandedPrompt),
  userPromptSource: 'aidlc-skill-expansion',
  priorAssistantSha256: kiroAssistantHash('What title do you want?'),
};
const session = {
  sessionId: 'session-A',
  models: {
    currentModelId: 'auto',
    availableModels: [{ modelId: 'auto', name: 'Auto' }],
  },
};
const update = (text, kind = 'agent_message_chunk', sessionId = 'session-A') => ({
  sessionId,
  update: { sessionUpdate: kind, content: { type: 'text', text } },
});
const setup = (input = {}, handlers = {}) => {
  const turn = createKiroAcpTurn({ ...options, ...input });
  const client = {
    request: vi.fn(async (method, params) => {
      if (handlers[method]) return handlers[method](params, turn);
      if (method === 'initialize')
        return { protocolVersion: 1, agentCapabilities: { loadSession: true } };
      if (method === 'session/new') return structuredClone(session);
      if (method === 'session/load') {
        turn.onUpdate(update(expandedPrompt.slice(0, 12), 'user_message_chunk'));
        turn.onUpdate(update(expandedPrompt.slice(12), 'user_message_chunk'));
        turn.onUpdate(update('What'));
        turn.onUpdate(update(' '));
        turn.onUpdate(update('title do you want?'));
        return { models: session.models };
      }
      if (method === 'session/prompt') {
        turn.onUpdate(update('Please choose a title.'));
        return { stopReason: 'end_turn' };
      }
      throw new Error('Unexpected request');
    }),
  };
  return { turn, client };
};

describe('native Kiro ACP turn', () => {
  it('verifies the latest prior turn for third and later production replies without replaying old messages', async () => {
    const { turn, client } = setup(
      {
        sessionId: 'session-A',
        production: true,
        historyMode: 'latest-turn',
        prompt: 'Yes, use that title',
        expectedUserPromptSha256: kiroPromptHash('Blue Lake'),
        priorAssistantSha256: kiroAssistantHash('Use Blue Lake?'),
        userPromptSource: 'retained-first-turn',
      },
      {
        'session/load': (_params, current) => {
          current.onUpdate(update(expandedPrompt, 'user_message_chunk'));
          current.onUpdate(update('old assistant text'.repeat(40000)));
          current.onUpdate(update('Blue ', 'user_message_chunk'));
          current.onUpdate(update('Lake', 'user_message_chunk'));
          current.onUpdate(update('Use Blue '));
          current.onUpdate(update('Lake?'));
          return { models: session.models };
        },
      },
    );
    expect(await turn.execute(client)).toMatchObject({
      ok: true,
      priorPromptObserved: true,
      priorAssistantObserved: true,
      historyMode: 'latest-turn',
      text: 'Please choose a title.',
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'session/load',
      'session/prompt',
    ]);
  });
  it('rejects a wrong latest turn even when the expected text exists earlier in history', async () => {
    const { turn, client } = setup(
      {
        sessionId: 'session-A',
        production: true,
        historyMode: 'latest-turn',
      },
      {
        'session/load': (_params, current) => {
          current.onUpdate(update(expandedPrompt, 'user_message_chunk'));
          current.onUpdate(update('What title do you want?'));
          current.onUpdate(update('different latest human message', 'user_message_chunk'));
          current.onUpdate(update('different latest assistant message'));
          return { models: session.models };
        },
      },
    );
    expect(await turn.execute(client)).toMatchObject({
      ok: false,
      protocolFailure: 'native_kiro_acp_history_unverified',
    });
    expect(client.request.mock.calls).toHaveLength(2);
  });
  it('production has no prompt deadline and truncates captured text without failing the turn', async () => {
    const { turn, client } = setup(
      { production: true },
      {
        'session/prompt': (_params, current) => {
          current.onUpdate(update('x'.repeat(600 * 1024)));
          current.onUpdate(update('continued after capture filled'));
          return { stopReason: 'end_turn' };
        },
      },
    );
    const report = await turn.execute(client);
    expect(report).toMatchObject({ ok: true, textTruncated: true, stopReason: 'end_turn' });
    expect(Buffer.byteLength(report.text)).toBeLessThanOrEqual(512 * 1024);
    expect(client.request).toHaveBeenLastCalledWith(
      'session/prompt',
      { sessionId: 'session-A', prompt: [{ type: 'text', text: firstPrompt }] },
      { timeoutMs: null },
    );
  });
  it('acknowledges the selected model before sending the fixed first prompt', async () => {
    const { turn, client } = setup();
    expect(await turn.execute(client)).toMatchObject({
      ok: true,
      sessionId: 'session-A',
      identitySource: 'kiro-acp-session-new',
      requestedModel: 'auto',
      observedModel: 'auto',
      modelSource: 'session/new.models',
      modelVerified: true,
      text: 'Please choose a title.',
      stopReason: 'end_turn',
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'session/new',
      'session/prompt',
    ]);
    expect(client.request).toHaveBeenLastCalledWith(
      'session/prompt',
      { sessionId: 'session-A', prompt: [{ type: 'text', text: firstPrompt }] },
      { timeoutMs: 600_000 },
    );
  });

  it('loads exactly the original ID, verifies replay, and excludes old text from the answer', async () => {
    const { turn, client } = setup({
      sessionId: 'session-A',
      prompt: 'Blue Lake',
      userPromptSource: 'retained-first-turn',
    });
    expect(await turn.execute(client)).toMatchObject({
      ok: true,
      sessionId: 'session-A',
      identitySource: 'kiro-acp-session-load',
      sessionLoadAcknowledged: true,
      priorPromptObserved: true,
      expectedUserPromptSha256: kiroPromptHash(expandedPrompt),
      replayedUserPromptSha256: kiroPromptHash(expandedPrompt),
      replayedUserChunks: 2,
      replayedAssistantChunks: 2,
      priorAssistantObserved: true,
      modelSource: 'session/load.models',
      text: 'Please choose a title.',
    });
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'session/load',
      'session/prompt',
    ]);
    expect(client.request).toHaveBeenCalledWith(
      'session/load',
      { cwd: options.project, sessionId: 'session-A', mcpServers: [] },
      { timeoutMs: 120_000 },
    );
  });

  it('never substitutes a new conversation when loading the original fails', async () => {
    const { turn, client } = setup(
      { sessionId: 'session-A', userPromptSource: 'retained-first-turn' },
      {
        'session/load': () => {
          throw Object.assign(new Error('private server message'), { rpcCode: -32603 });
        },
      },
    );
    const report = await turn.execute(client);
    expect(report).toMatchObject({
      ok: false,
      sessionLoadAcknowledged: false,
      protocolPhase: 'load',
      protocolFailure: 'native_kiro_acp_request_failed',
      rpcErrorCode: -32603,
    });
    expect(JSON.stringify(report)).not.toContain('private server message');
    expect(client.request.mock.calls.map(([method]) => method)).toEqual([
      'initialize',
      'session/load',
    ]);
  });

  it.each([
    ['no replay', () => {}],
    [
      'different prior prompt',
      (turn) => turn.onUpdate(update('A different task', 'user_message_chunk')),
    ],
    ['no prior assistant', (turn) => turn.onUpdate(update(expandedPrompt, 'user_message_chunk'))],
    [
      'different prior assistant',
      (turn) => {
        turn.onUpdate(update(expandedPrompt, 'user_message_chunk'));
        turn.onUpdate(update('Unrelated old answer.'));
      },
    ],
    [
      'the right task inside a different skill expansion',
      (turn) => {
        turn.onUpdate(update(`Changed rules\n${expandedPrompt}`, 'user_message_chunk'));
        turn.onUpdate(update('What title do you want?'));
      },
    ],
    [
      'an extra prior user message',
      (turn) => {
        turn.onUpdate(update(expandedPrompt, 'user_message_chunk'));
        turn.onUpdate(update('\nAn unrelated request.', 'user_message_chunk'));
        turn.onUpdate(update('What title do you want?'));
      },
    ],
  ])('refuses to prompt after a load with %s', async (_label, replay) => {
    const { turn, client } = setup(
      { sessionId: 'session-A', userPromptSource: 'retained-first-turn' },
      {
        'session/load': (_params, current) => {
          replay(current);
          return { models: session.models };
        },
      },
    );
    expect(await turn.execute(client)).toMatchObject({
      ok: false,
      protocolFailure: 'native_kiro_acp_history_unverified',
    });
    expect(client.request.mock.calls).toHaveLength(2);
  });

  it.each([undefined, null, '', 'not-a-hash', 'a'.repeat(63)])(
    'requires a retained full prompt hash before creating a resumed turn: %j',
    (expectedUserPromptSha256) => {
      expect(() =>
        createKiroAcpTurn({ ...options, sessionId: 'session-A', expectedUserPromptSha256 }),
      ).toThrow('Invalid native Kiro ACP arguments');
    },
  );

  it('accepts only canonical line endings and edge whitespace around exact replay', async () => {
    const { turn, client } = setup(
      { sessionId: 'session-A', userPromptSource: 'retained-first-turn' },
      {
        'session/load': (_params, current) => {
          current.onUpdate(
            update(` \r\n${expandedPrompt.replaceAll('\n', '\r\n')}\r\n`, 'user_message_chunk'),
          );
          current.onUpdate(update('What title do you want?'));
          return { models: session.models };
        },
      },
    );
    expect(await turn.execute(client)).toMatchObject({ ok: true, priorPromptObserved: true });
    expect(client.request).toHaveBeenCalledTimes(3);
  });

  it.each([
    ['missing model', {}],
    ['fallback model', { currentModelId: 'other', availableModels: [{ modelId: 'other' }] }],
    ['unadvertised model', { currentModelId: 'auto', availableModels: [] }],
  ])('refuses to prompt with %s', async (_label, models) => {
    const { turn, client } = setup(
      {},
      { 'session/new': () => ({ sessionId: 'session-A', models }) },
    );
    expect(await turn.execute(client)).toMatchObject({
      ok: false,
      modelVerified: false,
      protocolFailure: 'native_kiro_acp_model_unverified',
    });
    expect(client.request.mock.calls).toHaveLength(2);
  });

  it.each([undefined, null, '', '../outside', {}, 1])(
    'rejects invalid new session ID %j',
    async (sessionId) => {
      const { turn, client } = setup({}, { 'session/new': () => ({ ...session, sessionId }) });
      expect(await turn.execute(client)).toMatchObject({
        ok: false,
        protocolFailure: 'native_kiro_acp_invalid_session',
      });
      expect(client.request.mock.calls).toHaveLength(2);
    },
  );

  it('rejects another session appearing in load replay', async () => {
    const { turn, client } = setup(
      { sessionId: 'session-A', userPromptSource: 'retained-first-turn' },
      {
        'session/load': (_params, current) => {
          current.onUpdate(update(expandedPrompt, 'user_message_chunk', 'session-B'));
          return session;
        },
      },
    );
    expect(await turn.execute(client)).toMatchObject({
      ok: false,
      protocolFailure: 'native_kiro_acp_session_update_mismatch',
    });
    expect(client.request.mock.calls).toHaveLength(2);
  });

  it.each(['cancelled', 'max_tokens', 'max_turn_requests', 'refusal'])(
    'does not call %s a completed turn',
    async (stopReason) => {
      const { turn, client } = setup({}, { 'session/prompt': () => ({ stopReason }) });
      expect(await turn.execute(client)).toMatchObject({
        ok: false,
        stopReason,
        protocolFailure: 'native_kiro_acp_turn_not_finished',
      });
    },
  );

  it('rejects a server-declared failure even with an end_turn result', async () => {
    const { turn, client } = setup(
      {},
      {
        'session/prompt': () => ({
          stopReason: 'end_turn',
          _meta: { kiro: { turnFailureReason: 'internal_error' } },
        }),
      },
    );
    expect(await turn.execute(client)).toMatchObject({ ok: false });
  });

  it('only accepts tool permissions for the active synthetic prompt and session', async () => {
    const permission = {
      sessionId: 'session-A',
      options: [{ kind: 'allow_once', optionId: 'once' }],
    };
    const { turn, client } = setup(
      {},
      {
        'session/prompt': (_params, current) => {
          expect(current.onPermission(permission)).toEqual({
            outcome: { outcome: 'selected', optionId: 'once' },
          });
          expect(current.onPermission({ ...permission, sessionId: 'session-B' })).toEqual({
            outcome: { outcome: 'cancelled' },
          });
          return { stopReason: 'end_turn' };
        },
      },
    );
    expect(turn.onPermission(permission)).toEqual({ outcome: { outcome: 'cancelled' } });
    await turn.execute(client);
    expect(turn.onPermission(permission)).toEqual({ outcome: { outcome: 'cancelled' } });
  });

  it('rejects history beyond the bounded text budget', async () => {
    const { turn, client } = setup(
      { sessionId: 'session-A', userPromptSource: 'retained-first-turn' },
      {
        'session/load': (_params, current) =>
          current.onUpdate(update('x'.repeat(512 * 1024 + 1), 'user_message_chunk')),
      },
    );
    expect(await turn.execute(client)).toMatchObject({
      ok: false,
      protocolFailure: 'native_kiro_acp_text_limit',
    });
  });
});
