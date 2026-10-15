import { describe, expect, it } from 'vitest';
import { createNativeTurnOutput } from '../native/turn-output.js';

const session = 'verified-session';
const codex = (text = 'Which proposal do you prefer?') => [
  { type: 'thread.started', thread_id: session },
  { type: 'turn.started' },
  { type: 'item.completed', item: { id: 'a', type: 'agent_message', text } },
  { type: 'turn.completed' },
];
// Claude 2.1.257 bundled SDK schema and result producer, binary SHA-256
// 22f7d48f17193952c3c2d0b8bf2f31db2cd08fd5fb09a374fa321496b711d017.
// This is protocol fixture coverage, not a model or live CLI invocation.
const claude = (text = 'Proposal and question') => [
  { type: 'system', subtype: 'init', session_id: session },
  {
    type: 'assistant',
    session_id: session,
    parent_tool_use_id: null,
    message: {
      id: 'message-one',
      role: 'assistant',
      content: [{ type: 'text', text }],
      stop_reason: null,
    },
  },
  {
    type: 'result',
    subtype: 'success',
    session_id: session,
    is_error: false,
    result: text,
    stop_reason: 'end_turn',
    terminal_reason: 'completed',
  },
];
const collect = (events, options = {}, chunkSize = 31) => {
  const collector = createNativeTurnOutput({ harness: 'codex', ...options });
  const bytes = Buffer.from(events.map((event) => JSON.stringify(event)).join('\n'));
  for (let i = 0; i < bytes.length; i += chunkSize)
    collector.write(bytes.subarray(i, i + chunkSize));
  return collector.finish();
};

describe('bounded completed native turn output', () => {
  it.each([
    {
      stop_reason: 'tool_deferred',
      terminal_reason: 'tool_deferred',
      deferred_tool_use: { id: 'tool-one', name: 'AskUserQuestion', input: {} },
    },
    { stop_reason: null, terminal_reason: 'aborted_streaming' },
    { stop_reason: null, terminal_reason: 'aborted_tools' },
    { stop_reason: 'tool_deferred_unavailable' },
    { terminal_reason: 'background_requested' },
    { terminal_reason: 'stop_hook_prevented' },
    { terminal_reason: 'hook_stopped' },
    { terminal_reason: 'max_turns' },
    { terminal_reason: 'model_error' },
    { terminal_reason: 'budget_exhausted' },
    { terminal_reason: 'unknown_future_reason' },
    { deferred_tool_use: { id: 'pending-tool' } },
    { stop_reason: {} },
    { stop_reason: [] },
    { terminal_reason: null },
  ])('rejects explicit incomplete Claude terminal evidence %j despite success', (changes) => {
    const events = claude();
    events[2] = { ...events[2], ...changes };
    expect(() => collect(events, { harness: 'claude' })).toThrow('output_terminal');
  });

  it.each([undefined, null, '', 123, {}, [], 'x'.repeat(65537), 'x'.repeat(400000)])(
    'requires a present, bounded, nonempty exact Claude result (case %#)',
    (result) => {
      const events = claude();
      events[2] = { ...events[2], result };
      expect(() => collect(events, { harness: 'claude' })).toThrow('output_invalid');
    },
  );

  it.each(['status', 'task_notification', 'session_state_changed', 'informational'])(
    'allows same-session informational Claude system/%s after the single result',
    (subtype) => {
      const events = claude();
      events.push({
        type: 'system',
        subtype,
        session_id: session,
        status: null,
        summary: 'background metadata only',
        content: 'not assistant content',
      });
      expect(collect(events, { harness: 'claude' }, 1)).toEqual({
        nativeSessionId: session,
        messages: [{ type: 'text', text: 'Proposal and question' }],
      });
    },
  );

  it('allows the pinned top-level prompt suggestion after Claude result without publishing it', () => {
    expect(
      collect(
        [
          ...claude(),
          {
            type: 'prompt_suggestion',
            session_id: session,
            suggestion: 'Never send this as a human answer',
          },
        ],
        { harness: 'claude' },
      ).messages,
    ).toEqual([{ type: 'text', text: 'Proposal and question' }]);
  });

  it.each([
    { type: 'system', subtype: 'status', session_id: 'foreign' },
    { type: 'system', subtype: 'status', session_id: 123 },
    { type: 'system', subtype: 'status' },
    { type: 'system', subtype: 'api_error', session_id: session },
    { type: 'system', subtype: 'informational', session_id: session, prevent_continuation: true },
    { type: 'system', subtype: 'init', session_id: session },
    claude()[1],
    claude()[2],
  ])('does not ignore post-result execution, failure or unverified-session frames %#', (event) => {
    expect(() => collect([...claude(), event], { harness: 'claude' })).toThrow();
  });

  it.each([123, true, null, ['session'], { id: session }])(
    'rejects non-string observed session IDs %# without coercion',
    (thread_id) => {
      const events = codex();
      events[0] = { type: 'thread.started', thread_id };
      expect(() => collect(events)).toThrow('output_session');
    },
  );
  it.each([123, true, [], {}])('rejects non-string expected session IDs %#', (nativeSessionId) => {
    expect(() => createNativeTurnOutput({ harness: 'codex', nativeSessionId })).toThrow();
  });

  it.each(['\u00a0', '\u000b', '\u000c', '\u2028', '\u2029', '\ufeff'])(
    'rejects non-JSON whitespace U+%s outside strings',
    (whitespace) => {
      const wire = codex()
        .map((event) => JSON.stringify(event))
        .join('\n');
      for (const invalidWire of [
        wire.replaceAll(':', `:${whitespace}`),
        `${whitespace}${wire}`,
        `${wire}${whitespace}`,
        wire.replace(
          '{"type":"turn.completed"}',
          `{"type":"item.completed","ignored":true${whitespace}}\n{"type":"turn.completed"}`,
        ),
      ]) {
        const collector = createNativeTurnOutput({ harness: 'codex' });
        for (const byte of Buffer.from(invalidWire)) collector.write(Buffer.from([byte]));
        expect(() => collector.finish()).toThrow('output_invalid');
      }
    },
  );

  it('accepts RFC JSON whitespace and preserves legal Unicode whitespace inside message text', () => {
    const text = 'Proposal\u00a0and\u2028question';
    const wire = codex(text)
      .map((event) => JSON.stringify(event))
      .join('\r\n');
    const collector = createNativeTurnOutput({ harness: 'codex' });
    collector.write(Buffer.from(` \t${wire}\r\n\t `));
    expect(collector.finish().messages).toEqual([{ type: 'text', text }]);
  });
  it('preserves proposal before question in exact order and split UTF-8', () => {
    const events = codex('Proposal 😀\n| A | B |');
    events.splice(3, 0, {
      type: 'item.completed',
      item: { id: 'b', type: 'agent_message', text: 'Approve or change?' },
    });
    expect(collect(events, {}, 1)).toEqual({
      nativeSessionId: session,
      messages: [
        { type: 'text', text: 'Proposal 😀\n| A | B |' },
        { type: 'text', text: 'Approve or change?' },
      ],
    });
  });
  it('drains huge tool and reasoning strings preceding the final answer', () => {
    const events = codex();
    events.splice(
      2,
      0,
      {
        type: 'item.completed',
        item: { aggregated_output: 'x'.repeat(4 * 1024 * 1024), type: 'command_execution' },
      },
      { type: 'item.completed', item: { text: 'private'.repeat(100000), type: 'reasoning' } },
    );
    expect(collect(events, {}, 4096).messages).toEqual([
      { type: 'text', text: 'Which proposal do you prefer?' },
    ]);
  });
  it.each([
    ['missing terminal', () => codex().slice(0, -1)],
    ['missing session', () => codex().slice(1)],
    [
      'foreign session',
      () => [
        ...codex().slice(0, -1),
        { type: 'thread.started', thread_id: 'other' },
        { type: 'turn.completed' },
      ],
    ],
    ['failed turn', () => [...codex().slice(0, -1), { type: 'turn.failed' }]],
    [
      'failed turn after an error notice',
      () => [
        ...codex().slice(0, -1),
        { type: 'error', message: 'unexpected status 500' },
        { type: 'turn.failed', error: { message: 'unexpected status 500' } },
      ],
    ],
    [
      'interrupted turn after an error notice',
      () => [...codex().slice(0, -1), { type: 'error', message: 'stream closed' }],
    ],
    [
      'unfinished message',
      () => [
        codex()[0],
        codex()[1],
        { type: 'item.started', item: { type: 'agent_message', text: 'partial' } },
        codex()[3],
      ],
    ],
    ['overlong answer', () => codex('x'.repeat(65537))],
    ['duplicate completed item', () => [...codex().slice(0, -1), codex()[2], codex()[3]]],
  ])('rejects %s', (_name, events) => expect(() => collect(events())).toThrow());
  it('keeps a codex turn that completed after a retried stream error notice', () => {
    // Exact live shape (codex 0.145, 5 October 2026): a retried disconnect is
    // reported as `error`, then the turn continues and completes normally.
    const [started, turn, message, completed] = codex('Which plan should I use?');
    const notice = {
      type: 'error',
      message:
        'Reconnecting... 1/5 (stream disconnected before completion: The server had an error while processing your request. Sorry about that!)',
    };
    expect(collect([started, turn, notice, message, completed])).toEqual({
      nativeSessionId: session,
      messages: [{ type: 'text', text: 'Which plan should I use?' }],
    });
  });
  it('rejects expected session mismatch, credentials, incomplete JSON and malformed UTF-8', () => {
    expect(() => collect(codex(), { nativeSessionId: 'wrong' })).toThrow();
    expect(() => collect(codex('TOKEN'), { forbiddenBytes: ['TOKEN'] })).toThrow(
      'output_credential',
    );
    const split = codex('TO');
    split.splice(3, 0, {
      type: 'item.completed',
      item: { id: 'b', type: 'agent_message', text: 'KEN' },
    });
    expect(() => collect(split, { forbiddenBytes: ['TOKEN'] })).toThrow('output_credential');
    for (const bytes of [Buffer.from('{"type":"turn.'), Buffer.from([0xc3, 0x28])]) {
      const collector = createNativeTurnOutput({ harness: 'codex' });
      collector.write(bytes);
      expect(() => collector.finish()).toThrow();
    }
  });
  it('retains Claude assistant text without duplicating terminal result or including tools/thinking', () => {
    const events = [
      { type: 'system', session_id: session },
      {
        type: 'assistant',
        session_id: session,
        message: {
          role: 'assistant',
          content: [
            { type: 'thinking', text: 'PRIVATE' },
            { type: 'text', text: 'Proposal' },
            { type: 'tool_use', input: { x: 'PRIVATE' } },
          ],
        },
      },
      {
        type: 'assistant',
        session_id: session,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Which option?' }] },
      },
      {
        type: 'result',
        session_id: session,
        subtype: 'success',
        is_error: false,
        result: 'Which option?',
      },
    ];
    expect(collect(events, { harness: 'claude' }).messages.map((message) => message.text)).toEqual([
      'Proposal',
      'Which option?',
    ]);
    expect(() =>
      collect([...events.slice(0, -1), { ...events.at(-1), is_error: true }], {
        harness: 'claude',
      }),
    ).toThrow();
  });
  it('filters Claude subagent prose through the real projected JSON path and preserves multi-part final text', () => {
    const events = [
      {
        type: 'assistant',
        session_id: session,
        parent_tool_use_id: 'subagent-tool',
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'PRIVATE SUBAGENT OUTPUT' }],
        },
      },
      {
        type: 'assistant',
        session_id: session,
        parent_tool_use_id: null,
        message: {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Proposal\n' },
            { type: 'text', text: 'Question?' },
          ],
        },
      },
      {
        type: 'result',
        session_id: session,
        subtype: 'success',
        is_error: false,
        result: 'Proposal\nQuestion?',
      },
    ];
    expect(collect(events, { harness: 'claude' }, 1).messages).toEqual([
      { type: 'text', text: 'Proposal\n' },
      { type: 'text', text: 'Question?' },
    ]);
  });
  it('requires OpenCode stop after completed text, allowing earlier tool steps', () => {
    const events = [
      { type: 'step_finish', sessionID: session, part: { reason: 'tool-calls' } },
      { type: 'tool_use', sessionID: session, part: { state: { output: 'PRIVATE' } } },
      { type: 'text', sessionID: session, part: { type: 'text', text: 'Choose a workflow?' } },
      { type: 'step_finish', sessionID: session, part: { reason: 'stop' } },
    ];
    expect(collect(events, { harness: 'opencode' }).messages).toEqual([
      { type: 'text', text: 'Choose a workflow?' },
    ]);
    expect(() => collect(events.slice(0, -1), { harness: 'opencode' })).toThrow();
  });
  it('requires completed Kiro report plus verified history on resume; rejects truncation', () => {
    const report = {
      schemaVersion: 1,
      transport: 'kiro-acp',
      ok: true,
      sessionId: session,
      modelVerified: true,
      stopReason: 'end_turn',
      text: 'Question',
      priorPromptObserved: true,
      priorAssistantObserved: true,
      historyMode: 'latest-turn',
    };
    expect(collect([report], { harness: 'kiro', nativeSessionId: session }).messages).toEqual([
      { type: 'text', text: 'Question' },
    ]);
    for (const change of [
      { textTruncated: true },
      { priorPromptObserved: false },
      { stopReason: 'max_tokens' },
    ])
      expect(() =>
        collect([{ ...report, ...change }], { harness: 'kiro', nativeSessionId: session }),
      ).toThrow();
  });
  it('rejects malformed or duplicate JSON fields without retaining diagnostics', () => {
    const collector = createNativeTurnOutput({ harness: 'codex' });
    collector.write(Buffer.from('{"type":"thread.started","thread_id":"one","thread_id":"two"}\n'));
    expect(() => collector.finish()).toThrow('output_invalid');
  });
});

describe('Claude 2.1.296 query loop within one invocation', () => {
  // Sanitized actual installed-CLI sequence: Agent notification causes another
  // parent query after a successful result, announced by same-session init.
  const notification = { type: 'system', subtype: 'task_notification', session_id: session };
  it('keeps both completed parent responses and waits for the last declared query', () => {
    const events = [
      ...claude('Initial response').slice(0, 2),
      notification,
      claude('Initial response')[2],
      ...claude('Final question'),
    ];
    expect(collect(events, { harness: 'claude' }, 1).messages.map((m) => m.text)).toEqual([
      'Initial response',
      'Final question',
    ]);
  });
  it('does not substitute an earlier result for an incomplete or failed next query', () => {
    for (const following of [
      claude().slice(0, 1),
      claude().slice(0, 2),
      [...claude().slice(0, 2), { ...claude()[2], terminal_reason: 'model_error' }],
    ])
      expect(() =>
        collect([...claude(), notification, ...following], { harness: 'claude' }),
      ).toThrow();
  });
  it('still rejects undeclared queries, duplicate results and changed-session init', () => {
    for (const following of [
      claude()[1],
      claude()[2],
      { ...claude()[0], session_id: 'other' },
      { ...claude()[0], prevent_continuation: true },
    ])
      expect(() =>
        collect([...claude(), notification, following], { harness: 'claude' }),
      ).toThrow();
  });
  it('accepts a result-only follow-up and keeps the total output bound', () => {
    expect(
      collect([...claude('First'), claude()[0], claude('Final')[2]], {
        harness: 'claude',
      }).messages.map((m) => m.text),
    ).toEqual(['First', 'Final']);
    expect(() =>
      collect([...claude('x'.repeat(40000)), ...claude('x'.repeat(40000))], { harness: 'claude' }),
    ).toThrow('output_limit');
  });
});

it('bounds the number of declared Claude queries within one invocation', () => {
  expect(() =>
    collect(Array.from({ length: 33 }, () => claude('short')).flat(), { harness: 'claude' }),
  ).toThrow('output_limit');
});
