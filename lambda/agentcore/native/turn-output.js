// A streaming, bounded projection of harness JSONL. Ignored strings (including
// arbitrarily large tool output) are validated and drained, never retained.
// Only completed user-visible assistant messages may leave this module.
import { nativeInteractionMessages } from '../../shared/native-interaction.js';
import {
  nativeOutputDiagnostic,
  nativeRuntimeFailureCode,
} from '../../shared/native-execution-failure.js';

const OVERFLOW = Symbol('oversized-field');
const LIMIT = 64 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const jsonWhitespace = (character) => [' ', '\t', '\r', '\n'].includes(character);
// Claude 2.1.257 permits informational frames after its single result.
// They are not assistant content and cannot replace or complete another turn.
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
const invalid = (suffix = 'json', reason = suffix === 'json' ? 'json_grammar' : suffix) => {
  throw Object.assign(new Error(`native_execution_output_${suffix}`), {
    code: `native_execution_output_${suffix}`,
    outputReason: reason,
  });
};
// Claude 2.1.296's result producer removes only these bounded memory annotations.
// Keep the original assistant bytes in the interaction; normalize solely for
// comparison with the terminal result, after the original credential check.
const claudeResultText = (text) =>
  text.replace(
    /<\/?(?:cc-memory|cc_memory|ccmemory|CC-MEMORY|CC_MEMORY|CCMEMORY)(?=[\s/>])[^>]{0,1024}>/g,
    '',
  );
const CLAUDE_SILENT_RESPONSE = 'No response requested.';
const leaf = true;
const projection = {
  type: leaf,
  subtype: leaf,
  session_id: leaf,
  sessionID: leaf,
  sessionId: leaf,
  thread_id: leaf,
  is_error: leaf,
  result: leaf,
  stop_reason: leaf,
  terminal_reason: leaf,
  deferred_tool_use: leaf,
  prevent_continuation: leaf,
  schemaVersion: leaf,
  transport: leaf,
  ok: leaf,
  stopReason: leaf,
  text: leaf,
  textTruncated: leaf,
  modelVerified: leaf,
  priorPromptObserved: leaf,
  priorAssistantObserved: leaf,
  historyMode: leaf,
  parent_tool_use_id: leaf,
  item: { type: leaf, id: leaf, text: leaf, phase: leaf, status: leaf },
  message: { role: leaf, content: [{ type: leaf, text: leaf }] },
  part: { type: leaf, text: leaf, reason: leaf, sessionID: leaf, sessionId: leaf },
};

// Parse the entire grammar, retaining only the above projection. Values before
// their type discriminator remain bounded; an oversized reasoning field can
// be discarded, while an oversized assistant field fails instead of truncating.
const createProjectionParser = (onRecord) => {
  let stack = [];
  let token = null;
  let root;
  let rootDone = false;
  let retained = 0;
  let retainedCharacters = 0;
  const put = (value) => {
    const parent = stack.at(-1);
    if (!parent) {
      root = value;
      rootDone = true;
      return;
    }
    if (parent.keep) {
      if (parent.array) parent.value.push(value);
      else if (parent.child) parent.value[parent.key] = value;
      retained++;
      if (retained > 8192) invalid('json', 'record_limit');
    }
    parent.state = 'comma';
  };
  const childSchema = () => {
    const parent = stack.at(-1);
    return parent ? (parent.array ? parent.schema?.[0] : parent.child) : projection;
  };
  const finishToken = () => {
    const current = token;
    token = null;
    if (current.key) {
      if (current.overflow) invalid('json', 'field_limit');
      const key = JSON.parse(current.raw);
      const parent = stack.at(-1);
      parent.key = key;
      parent.child = Object.hasOwn(parent.schema ?? {}, key) ? parent.schema[key] : null;
      if (parent.child && Object.hasOwn(parent.value, key)) invalid('json', 'duplicate_field');
      parent.state = 'colon';
    } else {
      let value = null;
      if (current.string) {
        if (current.keep) value = current.overflow ? OVERFLOW : JSON.parse(current.raw);
      } else {
        const scalar = /^(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)$/.exec(
          current.raw,
        );
        if (!scalar || scalar[0] !== current.raw) invalid();
        if (current.keep) value = JSON.parse(current.raw);
      }
      put(value);
    }
  };
  const consume = (character) => {
    if (token) {
      if (!token.string) {
        if (!jsonWhitespace(character) && ![',', ']', '}'].includes(character)) {
          token.raw += character;
          if (token.raw.length > 128) invalid();
          return;
        }
        finishToken();
        return consume(character);
      }
      if (character.charCodeAt(0) < 32) invalid();
      if (token.unicode) {
        if (!/[a-fA-F0-9]/.test(character)) invalid();
        token.unicode--;
      } else if (token.escape) {
        if (!/["\\/bfnrtu]/.test(character)) invalid();
        token.escape = false;
        if (character === 'u') token.unicode = 4;
      } else if (character === '\\') token.escape = true;
      else if (character === '"') {
        if (token.keep && !token.overflow) token.raw += character;
        finishToken();
        return;
      }
      if (token.keep && !token.overflow) {
        token.raw += character;
        retainedCharacters++;
        if (
          token.raw.length > (token.key ? 1024 : LIMIT * 6 + 2) ||
          retainedCharacters > 1024 * 1024
        ) {
          token.raw = '';
          token.overflow = true;
        }
      }
      return;
    }
    if (character === '\n') {
      if (stack.length) invalid();
      if (rootDone) onRecord(root);
      root = undefined;
      rootDone = false;
      retained = 0;
      retainedCharacters = 0;
      return;
    }
    if (jsonWhitespace(character)) return;
    if (rootDone && !stack.length) invalid();
    const parent = stack.at(-1);
    if (parent?.state === 'colon') {
      if (character !== ':') invalid();
      parent.state = 'value';
      return;
    }
    if (parent?.state === 'comma') {
      if (character === ',') {
        parent.state = parent.array ? 'valueRequired' : 'keyRequired';
        return;
      }
      if (character !== (parent.array ? ']' : '}')) invalid();
    }
    if (character === '}' || character === ']') {
      if (
        !parent ||
        character !== (parent.array ? ']' : '}') ||
        !['comma', parent.array ? 'value' : 'key'].includes(parent.state)
      )
        invalid();
      stack.pop();
      put(parent.value);
      return;
    }
    const isKey = parent && ['key', 'keyRequired'].includes(parent.state);
    if (isKey && character !== '"') invalid();
    const schema = isKey ? leaf : childSchema();
    if (character === '"') {
      token = {
        string: true,
        key: isKey,
        keep: Boolean(schema),
        raw: schema ? '"' : '',
        escape: false,
        unicode: 0,
      };
    } else if (!isKey && (character === '{' || character === '[')) {
      if (stack.length >= 64) invalid('json', 'depth_limit');
      const array = character === '[';
      const keep = Boolean(schema && typeof schema === 'object');
      stack.push({
        schema: keep ? schema : null,
        keep,
        array,
        // A composite where a retained scalar belongs must not collapse to a
        // genuine null (e.g. a malformed nullable stop_reason or session ID).
        value: keep ? (array ? [] : Object.create(null)) : schema === leaf ? OVERFLOW : null,
        state: array ? 'value' : 'key',
        child: null,
      });
    } else if (!isKey && /[tfn0-9-]/.test(character)) {
      token = { string: false, keep: Boolean(schema), raw: character };
    } else invalid();
  };
  return {
    write(value) {
      for (const character of value) consume(character);
    },
    end() {
      if (token?.string) invalid('incomplete');
      if (token) finishToken();
      if (stack.length) invalid('incomplete');
      if (rootDone) onRecord(root);
    },
  };
};

export const createNativeTurnOutput = ({
  harness,
  nativeSessionId: expectedSession = null,
  forbiddenBytes = [],
  onDiagnostic,
} = {}) => {
  if (
    !['codex', 'claude', 'opencode', 'kiro'].includes(harness) ||
    (expectedSession !== null &&
      (typeof expectedSession !== 'string' || !SESSION.test(expectedSession)))
  )
    invalid('shape', 'record_shape');
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });
  let failure = null;
  let session = null;
  let completed = false;
  let started = false;
  let bytes = 0;
  let ended = false;
  let claudeFinalText = null;
  let claudeQueryStart = 0;
  let claudeQueries = 1;
  let records = 0;
  let recordType = 'none';
  let resultBytes = 0;
  let claudeLastBlock = null;
  const messages = [];
  const ids = new Set();
  const secrets = forbiddenBytes
    .map((value) => Buffer.from(value).toString('utf8'))
    .filter(Boolean);
  const add = (value) => {
    if (typeof value !== 'string' || !value.length) invalid('text', 'text_shape');
    bytes += Buffer.byteLength(value);
    if (bytes > LIMIT || messages.length >= 256) invalid('limit', 'text_limit');
    if (secrets.some((secret) => value.includes(secret))) invalid('credential');
    messages.push({ type: 'text', text: value });
  };
  const observeSession = (value) => {
    if (value === undefined) return;
    if (
      typeof value !== 'string' ||
      !SESSION.test(value) ||
      (session && session !== value) ||
      (expectedSession && expectedSession !== value)
    )
      invalid('session');
    session = value;
  };
  const afterCompleted = (event) => {
    // Claude 2.1.296 may consume a completed background-agent notification
    // in another parent query before this same CLI process exits. A new
    // same-session init explicitly starts that query; every query must still
    // end successfully. Never treat an earlier result as the final stop.
    if (
      harness === 'claude' &&
      event.type === 'system' &&
      event.subtype === 'init' &&
      event.session_id === session &&
      [undefined, null].includes(event.parent_tool_use_id) &&
      [undefined, false].includes(event.prevent_continuation)
    ) {
      if (++claudeQueries > 32) invalid('limit', 'query_limit');
      completed = false;
      claudeFinalText = null;
      claudeLastBlock = null;
      claudeQueryStart = messages.length;
      return;
    }
    const informational =
      harness === 'claude' &&
      typeof event.session_id === 'string' &&
      (event.type === 'prompt_suggestion' ||
        (event.type === 'system' && CLAUDE_POST_RESULT_SYSTEM.has(event.subtype))) &&
      (event.prevent_continuation === undefined || event.prevent_continuation === false);
    if (informational) return;
    invalid('terminal');
  };
  // Terminal projection has its own contract; it never admits a publication.
  const completeClaudeQuery = (event) => {
    if (event.subtype !== 'success' || event.is_error !== false) invalid('failed');
    // Success is also used for deferred tools and interrupted queries.
    // Explicit reasons must establish a completed response, independently
    // of subtype/is_error. Older/local-command results can omit the reason.
    if (
      (event.terminal_reason !== undefined && event.terminal_reason !== 'completed') ||
      ![undefined, null, 'end_turn', 'stop_sequence'].includes(event.stop_reason) ||
      Object.hasOwn(event, 'deferred_tool_use')
    )
      invalid('terminal');
    // Result text is a CLI projection, not necessarily a verbatim copy:
    // current producers use the last text block and remove memory markup;
    // retained producers/fixtures concatenate a multi-block response.
    resultBytes = typeof event.result === 'string' ? Buffer.byteLength(event.result) : 0;
    if (typeof event.result !== 'string' || resultBytes > LIMIT) invalid('result', 'result_shape');
    if (secrets.some((secret) => event.result.includes(secret))) invalid('credential');
    if (event.result.length === 0) {
      // A background notification can start a second parent query which
      // completes without another response. Only retain work from an
      // already completed query in THIS invocation, never a prior checkpoint.
      const silent =
        claudeQueryStart > 0 &&
        event.terminal_reason === 'completed' &&
        event.stop_reason === 'end_turn' &&
        (messages.length === claudeQueryStart ||
          (messages.length === claudeQueryStart + 1 && claudeFinalText === CLAUDE_SILENT_RESPONSE));
      if (!silent) invalid('result', 'result_empty');
      for (const message of messages.splice(claudeQueryStart))
        bytes -= Buffer.byteLength(message.text);
    } else if (messages.length === claudeQueryStart) add(event.result);
    else if (
      ![claudeFinalText, claudeLastBlock].some(
        (text) => text === event.result || claudeResultText(text) === event.result,
      )
    )
      invalid('result', 'result_mismatch');
    completed = true;
  };
  const parser = createProjectionParser((event) => {
    records++;
    if (!event || typeof event !== 'object' || Array.isArray(event))
      invalid('shape', 'record_shape');
    recordType = event.type;
    // Incremental ACP presentation is independent of the final interaction record.
    if (harness === 'kiro' && event.transport === 'kiro-acp-activity' && event.schemaVersion === 1)
      return;
    for (const value of [
      event.thread_id,
      event.session_id,
      event.sessionID,
      event.sessionId,
      event.part?.sessionID,
      event.part?.sessionId,
    ])
      observeSession(value);
    if (completed) {
      afterCompleted(event);
      return;
    }
    if (harness === 'codex') {
      // Codex 0.145 emits `error` for every server error notification,
      // including retried stream disconnects ("Reconnecting... 1/5"), and keeps
      // running. Only the turn's final status decides: `turn.failed` (or no
      // `turn.completed`, for an interrupted turn) is never a completed turn.
      if (event.type === 'turn.failed') invalid('failed');
      if (event.type === 'turn.started') {
        if (started) invalid('terminal');
        started = true;
      }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') {
        if (!started || !session) invalid('incomplete');
        if (typeof event.item.id !== 'string' || ids.has(event.item.id))
          invalid('shape', 'message_shape');
        ids.add(event.item.id);
        add(event.item.text);
      }
      if (event.type === 'turn.completed') {
        if (!started || !session) invalid('incomplete');
        completed = true;
      }
    } else if (harness === 'claude') {
      if (event.parent_tool_use_id !== undefined && event.parent_tool_use_id !== null) return;
      if (event.type === 'assistant') {
        if (event.message?.role !== 'assistant' || !session) invalid('session');
        if (!Array.isArray(event.message.content)) invalid('shape', 'message_shape');
        const start = messages.length;
        for (const part of event.message.content) {
          if (!part || typeof part !== 'object') invalid('shape', 'message_shape');
          if (part.type === 'text') add(part.text);
        }
        if (messages.length > start) {
          claudeFinalText = messages
            .slice(start)
            .map((message) => message.text)
            .join('');
          claudeLastBlock = messages.at(-1).text;
        }
      }
      if (event.type === 'result') completeClaudeQuery(event);
    } else if (harness === 'opencode') {
      if (event.type === 'error') invalid('failed');
      if (event.type === 'text' && event.part?.type === 'text') {
        if (!session) invalid('session');
        add(event.part.text);
      }
      if (event.type === 'step_finish') {
        if (event.part?.reason === 'stop') completed = true;
        else if (event.part?.reason !== 'tool-calls') invalid('terminal');
      }
    } else {
      if (
        event.schemaVersion !== 1 ||
        event.transport !== 'kiro-acp' ||
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
      completed = true;
    }
  });
  const reject = (error) => {
    if (failure) return;
    const safeCode = nativeRuntimeFailureCode(error);
    const code = safeCode.startsWith('native_execution_output_')
      ? safeCode
      : 'native_execution_output_shape';
    const reason = Object.getOwnPropertyDescriptor(error ?? {}, 'outputReason')?.value;
    const diagnostic = nativeOutputDiagnostic({
      reason: reason ?? 'unexpected',
      recordType: typeof recordType === 'string' ? recordType : 'other',
      recordIndex: code === 'native_execution_output_json' ? records + 1 : records,
      queries: claudeQueries,
      messages: messages.length,
      textBytes: bytes,
      resultBytes,
    });
    failure = Object.assign(new Error(code), { code, outputDiagnostic: diagnostic });
    try {
      onDiagnostic?.(diagnostic);
    } catch {
      // Advisory telemetry must not change the parser result.
    }
  };
  const decode = (chunk, stream) => {
    try {
      return decoder.decode(chunk, { stream });
    } catch {
      invalid('utf8', 'utf8');
    }
  };
  return {
    write(chunk) {
      if (ended) invalid('terminal');
      if (failure) return;
      try {
        parser.write(decode(chunk, true));
      } catch (error) {
        reject(error);
      }
    },
    finish() {
      if (ended) invalid('terminal');
      ended = true;
      if (failure) throw failure;
      try {
        parser.write(decode(undefined, false));
        parser.end();
        if (!completed || !session) invalid('incomplete');
        if (!messages.some((message) => message.text.trim())) invalid('text', 'no_visible_text');
        let normalized;
        try {
          normalized = nativeInteractionMessages(messages);
        } catch {
          invalid('text', 'text_encoding');
        }
        // Also reject credentials split across adjacent completed messages.
        if (
          secrets.some((secret) =>
            normalized
              .map((message) => message.text)
              .join('')
              .includes(secret),
          )
        )
          invalid('credential');
        return { nativeSessionId: session, messages: normalized };
      } catch (error) {
        reject(error);
        throw failure;
      }
    },
  };
};
