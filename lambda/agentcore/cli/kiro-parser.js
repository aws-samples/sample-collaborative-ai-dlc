// Incremental parser for `kiro-cli chat --output-format stream-json` output.
//
// The v2 agent engine emits its ACP events as one JSON object per line on
// stdout (stderr stays empty on a normal run):
//   {"type":"runStarted","data":{"engine":"v2",...}}
//   {"type":"metadata","data":{"sessionId":"...","meteringUsage":[...]}}  → session id, credits
//   {"type":"sessionUpdate","data":{"update":{"sessionUpdate":"agent_message_chunk",...}}} → text
//   {"type":"sessionUpdate","data":{"update":{"sessionUpdate":"tool_call",...}}}          → tool start
//   {"type":"sessionUpdate","data":{"update":{"sessionUpdate":"tool_call_update",...}}}   → tool result
//   {"type":"runError","data":{"stage":"prompt","message":"..."}}                          → errors
//   {"type":"runFinished","data":{"status":"success","finalText":"..."}}
//
// Message text arrives as small chunks, so chunks are buffered and emitted as
// one message when a tool starts or the run ends. Tool calls are paired by
// toolCallId: the start carries the title/kind/input, later updates carry the
// status and raw output. Failed MCP calls report status "completed" with
// `isError` in the result envelope, so that flag also marks the tool failed.
//
// The parser mirrors the codex/opencode parser surface so the output sink and
// one-shot callers consume all three identically. Unknown events degrade to
// diagnostics, never throw — the stream schema may drift between releases.

const TERMINAL_STATUSES = new Set(['completed', 'failed']);

// Credits for one turn arrive as a list of metering entries on the final
// metadata event of the turn. Sum the credit-denominated entries.
const creditsFrom = (data) => {
  const usage = Array.isArray(data?.meteringUsage) ? data.meteringUsage : [];
  let total = null;
  for (const entry of usage) {
    const value = Number(entry?.value);
    if (entry?.unit !== 'credit' || !Number.isFinite(value) || value < 0) continue;
    total = (total ?? 0) + value;
  }
  return total;
};

// Flatten Kiro's tool result envelope ({items:[{Text}|{Json}]}) to plain text.
// MCP results nest the MCP content envelope inside Json; shell results carry
// stdout/stderr; anything else degrades to JSON.
const outputText = (rawOutput) => {
  const items = Array.isArray(rawOutput?.items) ? rawOutput.items : [];
  return items
    .map((item) => {
      if (typeof item?.Text === 'string') return item.Text;
      const json = item?.Json;
      if (json === undefined || json === null) return '';
      if (Array.isArray(json.content)) {
        return json.content.map((part) => part?.text ?? '').join('\n');
      }
      if (typeof json.stdout === 'string' || typeof json.stderr === 'string') {
        return [json.stdout, json.stderr].filter(Boolean).join('');
      }
      return JSON.stringify(json);
    })
    .filter(Boolean)
    .join('\n');
};

const shellFailed = (rawOutput) =>
  (Array.isArray(rawOutput?.items) ? rawOutput.items : []).some((item) => {
    const status = item?.Json?.exit_status;
    return typeof status === 'string' && !/\bexit status: 0\b/.test(status);
  });

const mcpFailed = (rawOutput) =>
  (Array.isArray(rawOutput?.items) ? rawOutput.items : []).some(
    (item) => item?.Json?.isError === true,
  );

const targetsOf = (call) => {
  const fromLocations = (Array.isArray(call.locations) ? call.locations : [])
    .map((location) => location?.path)
    .filter(Boolean);
  if (fromLocations.length) return fromLocations;
  return call.rawInput?.path ? [String(call.rawInput.path)] : [];
};

// Map a finished tool call to the normalized tool-event shape shared with the
// codex/opencode parsers: { name, status, input, output, error, targets, event }.
const toolOf = (call, event) => {
  const meta = call.meta ?? {};
  const output = outputText(call.rawOutput);
  const failed =
    call.status === 'failed' || shellFailed(call.rawOutput) || mcpFailed(call.rawOutput);
  const tool = {
    name: String(meta.toolName ?? call.title ?? 'tool'),
    server: meta.mcpServerName ?? null,
    status: failed ? 'error' : 'completed',
    input: call.rawInput ?? null,
    output,
    error: failed ? output || 'failed' : null,
    event,
  };
  if (meta.mcpServerName) return tool;
  if (call.kind === 'read') return { ...tool, name: 'fs_read', targets: targetsOf(call) };
  if (call.kind === 'edit') {
    return {
      ...tool,
      name: 'edit',
      targets: targetsOf(call),
      editAction: call.rawInput?.command === 'create' ? 'Created' : 'Updated',
    };
  }
  if (call.kind === 'execute') return { ...tool, name: 'shell', input: call.rawInput?.command };
  return tool;
};

export const createKiroJsonlParser = ({
  onText = () => {},
  onTool = () => {},
  onError = () => {},
  onSession = () => {},
  onUsage = () => {},
  onDiagnostic = () => {},
} = {}) => {
  let pending = '';
  let message = '';
  const calls = new Map();
  const state = {
    text: '',
    sessionId: null,
    metrics: null,
    errors: [],
    diagnostics: [],
  };

  const flushMessage = () => {
    if (!message) return;
    const text = message;
    message = '';
    state.text = state.text ? `${state.text}\n${text}` : text;
    onText(text);
  };

  const error = (text, event) => {
    flushMessage();
    state.errors.push(text);
    onError(text, event);
  };

  const consumeUpdate = (update, event) => {
    const kind = String(update?.sessionUpdate ?? '');
    if (kind === 'agent_message_chunk') {
      if (typeof update.content?.text === 'string') message += update.content.text;
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      const id = update.toolCallId;
      if (!id) return;
      if (kind === 'tool_call') flushMessage();
      const call = calls.get(id) ?? {};
      const merged = {
        ...call,
        ...update,
        meta: call.meta ?? update._meta?.kiro ?? null,
      };
      if (!TERMINAL_STATUSES.has(merged.status)) {
        calls.set(id, merged);
        return;
      }
      calls.delete(id);
      flushMessage();
      onTool(toolOf(merged, event));
      return;
    }
    // Thought chunks, plans, and anything new stay hidden context.
    const summary = JSON.stringify(update);
    state.diagnostics.push(summary);
    onDiagnostic(summary);
  };

  const consumeLine = (line) => {
    const trimmed = String(line ?? '').trim();
    if (!trimmed) return;
    let event;
    try {
      event = JSON.parse(trimmed);
    } catch {
      state.diagnostics.push(trimmed);
      onDiagnostic(trimmed);
      return;
    }

    const type = String(event?.type ?? '');
    const data = event?.data ?? {};

    if (!state.sessionId && data.sessionId) {
      state.sessionId = String(data.sessionId);
      onSession(state.sessionId);
    }

    if (type === 'sessionUpdate') {
      consumeUpdate(data.update, event);
      return;
    }

    if (type === 'metadata') {
      const credits = creditsFrom(data);
      if (credits !== null) {
        const total = (state.metrics?.credits ?? 0) + credits;
        state.metrics = { ...state.metrics, credits: total };
        onUsage({ credits }, event);
      }
      return;
    }

    if (type === 'runError') {
      error(String(data.message ?? 'Kiro reported an error'), event);
      return;
    }

    if (type === 'runFinished') {
      flushMessage();
      if (data.status && data.status !== 'success') {
        error(`Kiro run ended with status ${data.status} (${data.stopReason ?? 'unknown'})`, event);
      }
    }

    // runStarted and anything new — ignore quietly.
  };

  return {
    state,
    write(chunk) {
      pending += String(chunk ?? '');
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    },
    flush() {
      if (pending) consumeLine(pending);
      pending = '';
      flushMessage();
      return state;
    },
  };
};

export const parseKiroJsonl = (stdout = '') => {
  const parser = createKiroJsonlParser();
  parser.write(stdout);
  return parser.flush();
};

export const __test = { creditsFrom, outputText, toolOf };
