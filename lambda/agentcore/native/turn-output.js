// A streaming, bounded projection of harness JSONL. Ignored strings (including
// arbitrarily large tool output) are validated and drained, never retained.
// Only completed user-visible assistant messages may leave this module.
import { observeNativeMethodOutput } from './method-output.js';
import { nativeInteractionMessages } from '../../shared/native-interaction.js';
import {
  nativeOutputDiagnostic,
  nativeRuntimeFailureCode,
} from '../../shared/native-execution-failure.js';

import { createNativeHarnessDecoder, invalidNativeOutput as invalid } from './harness-output.js';

const OVERFLOW = Symbol('oversized-field');
const LIMIT = 64 * 1024;
const SESSION = /^[A-Za-z0-9_-]{1,128}$/;
const jsonWhitespace = (character) => [' ', '\t', '\r', '\n'].includes(character);
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
const methodProjection = {
  ...projection,
  item: { ...projection.item, command: leaf, exit_code: leaf, aggregated_output: leaf },
  message: {
    role: leaf,
    content: [
      {
        type: leaf,
        text: leaf,
        id: leaf,
        name: leaf,
        input: { command: leaf },
        tool_use_id: leaf,
        is_error: leaf,
        content: leaf,
      },
    ],
  },
  tool_use_result: { stdout: leaf },
  part: {
    ...projection.part,
    tool: leaf,
    state: { status: leaf, input: { command: leaf }, output: leaf },
  },
};
const createProjectionParser = (onRecord, schemaRoot) => {
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
    return parent ? (parent.array ? parent.schema?.[0] : parent.child) : schemaRoot;
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
  observeMethod = false,
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
  let bytes = 0;
  let ended = false;
  let records = 0;
  let recordType = 'none';
  const messages = [];
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
  const harnessDecoder = createNativeHarnessDecoder(harness, {
    expectedSession,
    add,
    messages,
    session: () => session,
    credential: (text) => {
      if (secrets.some((secret) => text.includes(secret))) invalid('credential');
    },
    removeTrailing: (count) => {
      for (let n = 0; n < count; n++) bytes -= Buffer.byteLength(messages.pop().text);
    },
  });
  const method = observeMethod ? observeNativeMethodOutput(harness) : null;
  const parser = createProjectionParser(
    (event) => {
      records++;
      if (!event || typeof event !== 'object' || Array.isArray(event))
        invalid('shape', 'record_shape');
      recordType = event.type;
      // The bridge's incremental activity is not an interaction record.
      if (
        harness === 'kiro' &&
        event.transport === 'kiro-acp-activity' &&
        event.schemaVersion === 1
      )
        return;
      // Retain conflict checks across all identity fields, but only the selected
      // decoder can recognize its protocol's records and terminal boundary.
      for (const value of [
        event.thread_id,
        event.session_id,
        event.sessionID,
        event.sessionId,
        event.part?.sessionID,
        event.part?.sessionId,
      ])
        observeSession(value);
      harnessDecoder.write(event);
      method?.write(event);
    },
    method ? methodProjection : projection,
  );
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
      queries: harnessDecoder.diagnostic().queries,
      messages: messages.length,
      textBytes: bytes,
      resultBytes: harnessDecoder.diagnostic().resultBytes,
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
        harnessDecoder.finish();
        if (!session) invalid('incomplete');
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
        return {
          nativeSessionId: session,
          messages: normalized,
          ...(method ? { method: method.result() } : {}),
        };
      } catch (error) {
        reject(error);
        throw failure;
      }
    },
  };
};
