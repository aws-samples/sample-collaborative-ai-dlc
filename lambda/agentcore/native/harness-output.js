// Each invocation selects one installed harness protocol. These decoders own
// terminal evidence only; they cannot publish, answer a question or finish a workflow.
export const invalidNativeOutput = (
  suffix = 'json',
  reason = suffix === 'json' ? 'json_grammar' : suffix,
) => {
  throw Object.assign(new Error(`native_execution_output_${suffix}`), {
    code: `native_execution_output_${suffix}`,
    outputReason: reason,
  });
};
const invalid = invalidNativeOutput;
const LIMIT = 64 * 1024;
const singleTurn = (write) => {
  let completed = false;
  return {
    write(event) {
      if (completed) invalid('terminal');
      completed = write(event);
    },
    finish() {
      if (!completed) invalid('incomplete');
    },
    diagnostic: () => ({ queries: 1, resultBytes: 0 }),
  };
};

const codexDecoder = ({ add, session }) => {
  let started = false;
  let thread = false;
  const ids = new Set();
  return singleTurn((event) => {
    if (event.type === 'thread.started') {
      if (thread || started || !event.thread_id) invalid('session');
      thread = true;
    }
    if (event.type === 'turn.started') {
      if (started) invalid('terminal');
      if (!thread) invalid('incomplete');
      started = true;
    }
    // Retriable stream `error` notifications are not a final turn failure.
    if (event.type === 'turn.failed') invalid('failed');
    if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
      if (!started || !session()) invalid('incomplete');
      if (typeof event.item.id !== 'string' || ids.has(event.item.id))
        invalid('shape', 'message_shape');
      ids.add(event.item.id);
      add(event.item.text);
    }
    if (event.type !== 'turn.completed') return false;
    if (!started || !session()) invalid('incomplete');
    return true;
  });
};

const openCodeDecoder = ({ add, session }) =>
  singleTurn((event) => {
    if (event.type === 'error') invalid('failed');
    if (event.type === 'text' && event.part?.type === 'text') {
      if (!event.sessionID || !session()) invalid('session');
      add(event.part.text);
    }
    if (event.type !== 'step_finish') return false;
    if (!event.sessionID || !session()) invalid('session');
    if (event.part?.reason === 'stop') return true;
    if (event.part?.reason !== 'tool-calls') invalid('terminal');
    return false;
  });

// Existing bridge contract only. Kiro admission and full qualification remain NE-18.
const kiroDecoder = ({ add, expectedSession }) =>
  singleTurn((event) => {
    if (
      event.schemaVersion !== 1 ||
      event.transport !== 'kiro-acp' ||
      !event.sessionId ||
      event.ok !== true ||
      event.stopReason !== 'end_turn' ||
      event.modelVerified !== true ||
      event.textTruncated === true ||
      (expectedSession &&
        (event.priorPromptObserved !== true ||
          event.priorAssistantObserved !== true ||
          event.historyMode !== 'latest-turn'))
    )
      invalid('terminal');
    add(event.text);
    return true;
  });

const CLAUDE_POST_RESULT_SYSTEM = new Set([
  'status',
  'task_notification',
  'session_state_changed',
  'background_tasks_changed',
  'task_started',
  'task_updated',
  'task_progress',
  'task_summary',
  'post_turn_summary',
  'turn_duration',
  'files_persisted',
  'commands_changed',
  'vcs_state_changed',
  'code_change_published',
  'memory_saved',
  'notification',
  'informational',
]);
// The installed 2.1.296 result producer selects the last text block and removes
// bounded memory annotations. Preserve original display bytes; normalize only
// for terminal comparison, after credential checks.
const claudeResultText = (text) =>
  text.replace(
    /<\/?(?:cc-memory|cc_memory|ccmemory|CC-MEMORY|CC_MEMORY|CCMEMORY)(?=[\s/>])[^>]{0,1024}>/g,
    '',
  );
const claudeResponseMatches = (response, result) =>
  response.text === result || claudeResultText(response.text) === result;
const CLAUDE_SILENT_RESPONSE = 'No response requested.';

const claudeDecoder = ({ add, messages, session, credential, removeTrailing }) => {
  let completed = false;
  let queryStart = 0;
  let queries = 1;
  let resultCount = 0;
  let matchedResponse = -1;
  let lastResult = null;
  let silentResults = 0;
  let trailingSilent = 0;
  let resultBytes = 0;
  const responses = [];
  const recordResponse = (start) => {
    responses.push({
      text: messages.at(-1).text,
      silent: messages.length === start + 1 && messages[start].text === CLAUDE_SILENT_RESPONSE,
    });
  };
  const seal = () => {
    removeTrailing(trailingSilent);
    trailingSilent = 0;
  };
  const startQuery = () => {
    if (++queries > 32) invalid('limit', 'query_limit');
    seal();
    completed = false;
    queryStart = messages.length;
    resultCount = 0;
    matchedResponse = -1;
    lastResult = null;
    silentResults = 0;
    responses.length = 0;
  };
  const completeSilent = (event) => {
    // A background notification may complete without new visible text, but
    // only after a completed query in this invocation. Never reuse a prior turn.
    if (
      !(queryStart > 0 || lastResult) ||
      event.terminal_reason !== 'completed' ||
      event.stop_reason !== 'end_turn'
    )
      invalid('result', 'result_empty');
    silentResults++;
    let last = responses.length - 1;
    while (last >= 0 && responses[last].silent) last--;
    const trailing = responses.length - 1 - last;
    completed =
      trailing <= silentResults &&
      (last < 0
        ? queryStart > 0
        : lastResult !== null &&
          last > lastResult.after &&
          claudeResponseMatches(responses[last], lastResult.text));
    trailingSilent = completed ? trailing : 0;
  };
  const complete = (event) => {
    if (!event.session_id) invalid('session');
    if (event.subtype !== 'success' || event.is_error !== false) invalid('failed');
    // Local-command results can omit reasons. Explicit interrupted/deferred
    // reasons never establish completion, even with subtype success.
    if (
      (event.terminal_reason !== undefined && event.terminal_reason !== 'completed') ||
      ![undefined, null, 'end_turn', 'stop_sequence'].includes(event.stop_reason) ||
      Object.hasOwn(event, 'deferred_tool_use')
    )
      invalid('terminal');
    resultBytes = typeof event.result === 'string' ? Buffer.byteLength(event.result) : 0;
    if (typeof event.result !== 'string' || resultBytes > LIMIT) invalid('result', 'result_shape');
    credential(event.result);
    if (resultCount++ > 0 && ++queries > 32) invalid('limit', 'query_limit');
    if (!event.result.length) return completeSilent(event);
    silentResults = 0;
    trailingSilent = 0;
    if (!responses.length) {
      if (resultCount !== 1) invalid('result', 'result_mismatch');
      const start = messages.length;
      add(event.result);
      recordResponse(start);
    }
    // 2.1.296 drains deferred parent results FIFO. Match each against a distinct
    // response and require a possible match at the last response before EOF.
    const after = matchedResponse;
    matchedResponse = responses.findIndex(
      (response, index) => index > after && claudeResponseMatches(response, event.result),
    );
    if (matchedResponse < 0) invalid('result', 'result_mismatch');
    lastResult = { text: event.result, after };
    completed =
      responses.length - 1 > after && claudeResponseMatches(responses.at(-1), event.result);
  };
  const afterResult = (event) => {
    if (event.type === 'result' && [undefined, null].includes(event.parent_tool_use_id)) {
      if (completed && event.result !== '' && matchedResponse === responses.length - 1)
        invalid('terminal');
      return complete(event);
    }
    if (
      completed &&
      event.type === 'system' &&
      event.subtype === 'init' &&
      event.session_id === session() &&
      [undefined, null].includes(event.parent_tool_use_id) &&
      [undefined, false].includes(event.prevent_continuation)
    )
      return startQuery();
    if (
      typeof event.session_id === 'string' &&
      (event.type === 'prompt_suggestion' ||
        (event.type === 'system' && CLAUDE_POST_RESULT_SYSTEM.has(event.subtype))) &&
      [undefined, false].includes(event.prevent_continuation)
    )
      return;
    invalid('terminal');
  };
  return {
    write(event) {
      if (completed || resultCount > 0) return afterResult(event);
      if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) return;
      if (event.type === 'assistant') {
        if (event.message?.role !== 'assistant' || !event.session_id || !session())
          invalid('session');
        if (!Array.isArray(event.message.content)) invalid('shape', 'message_shape');
        const start = messages.length;
        for (const part of event.message.content) {
          if (!part || typeof part !== 'object') invalid('shape', 'message_shape');
          if (part.type === 'text') add(part.text);
        }
        if (messages.length > start) recordResponse(start);
      }
      if (event.type === 'result') {
        complete(event);
      }
    },
    finish() {
      if (!completed) invalid('incomplete');
      seal();
    },
    diagnostic: () => ({ queries, resultBytes }),
  };
};

export const createNativeHarnessDecoder = (harness, output) => {
  switch (harness) {
    case 'claude':
      return claudeDecoder(output);
    case 'codex':
      return codexDecoder(output);
    case 'opencode':
      return openCodeDecoder(output);
    case 'kiro':
      return kiroDecoder(output);
    default:
      return invalid('shape', 'record_shape');
  }
};
