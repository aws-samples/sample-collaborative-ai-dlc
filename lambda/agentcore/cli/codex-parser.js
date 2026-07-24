// Incremental parser for `codex exec --json` JSONL output.
//
// Codex emits one event per line on stdout (progress goes to stderr):
//   {"type":"thread.started","thread_id":"..."}          → session id
//   {"type":"item.completed","item":{...}}               → completed items
//   {"type":"turn.completed","usage":{...}}              → token usage
//   {"type":"turn.failed","error":{...}} / {"type":"error",...} → errors
//
// Completed item types map to the runtime's normalized events:
//   agent_message              → text
//   command_execution          → tool (name "shell", command/output/exit_code)
//   mcp_tool_call              → tool (server+tool name, status)
//   file_change                → tool (name "edit", list of changed paths)
//   web_search                 → tool (name "web_search")
//   reasoning / plan_update    → diagnostics (hidden by default)
//
// The parser accepts arbitrarily split chunks and mirrors the opencode parser's
// surface so the output sink and one-shot callers consume both identically.
// Unknown event/item types degrade to diagnostics, never throw — Codex's JSONL
// schema may drift between releases.

const numberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const usageFrom = (event) => {
  const usage = event?.usage ?? {};
  const fields = {
    tokensInput: numberOrNull(usage.input_tokens),
    tokensOutput: numberOrNull(usage.output_tokens),
    tokensReasoning: numberOrNull(usage.reasoning_output_tokens),
    tokensCacheRead: numberOrNull(usage.cached_input_tokens),
    // Observed live (not in the exec docs): turn.completed also reports
    // cache_write_input_tokens.
    tokensCacheWrite: numberOrNull(usage.cache_write_input_tokens),
  };
  const metrics = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value >= 0),
  );
  return Object.keys(metrics).length ? metrics : null;
};

const errorMessage = (event) => {
  const error = event?.error ?? event?.message;
  if (typeof error === 'string') return error;
  return error?.message ?? error?.code ?? 'Codex reported an error';
};

// Flatten an MCP tool-call result to plain text. Codex reports the raw MCP
// envelope ({content:[{type:'text',text}], structured_content}); strings pass
// through, anything else non-null degrades to JSON.
const mcpResultText = (result) => {
  if (result === null || result === undefined) return '';
  if (typeof result === 'string') return result;
  if (Array.isArray(result?.content)) {
    const text = result.content
      .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
      .filter(Boolean)
      .join('\n');
    if (text) return text;
  }
  try {
    return JSON.stringify(result);
  } catch {
    return String(result);
  }
};

// Map a completed non-message item to the normalized tool-event shape shared
// with the opencode parser: { name, status, input, output, error, event }.
// Returns null for items that are not tool-like (reasoning, plan updates).
const toolOf = (item, event) => {
  const type = String(item?.type ?? '');
  const failed = String(item?.status ?? '').toLowerCase() === 'failed';
  if (type === 'command_execution') {
    const ok = !failed && (item.exit_code === undefined || item.exit_code === 0);
    return {
      name: 'shell',
      status: ok ? 'completed' : 'error',
      input: item.command ?? null,
      output: item.aggregated_output ?? '',
      error: ok ? null : `exit ${item.exit_code ?? 'unknown'}`,
      event,
    };
  }
  if (type === 'mcp_tool_call') {
    // Observed live: `result` is the MCP content envelope
    // {content:[{type:'text',text}],structured_content} — flatten to text so
    // the sink never renders "[object Object]". A failed call often carries
    // its message THERE (error stays null), so surface it as the error too.
    const resultText = mcpResultText(item.result ?? item.output);
    return {
      name: item.tool ?? 'tool',
      server: item.server ?? null,
      status: failed ? 'error' : 'completed',
      input: item.arguments ?? item.input ?? null,
      output: resultText,
      error: failed ? (item.error ?? (resultText || 'failed')) : null,
      event,
    };
  }
  if (type === 'file_change') {
    const changes = Array.isArray(item.changes) ? item.changes : [];
    return {
      name: 'edit',
      status: failed ? 'error' : 'completed',
      input:
        changes.map((c) => `${c?.kind ?? 'update'} ${c?.path ?? ''}`.trim()).join('\n') || null,
      // The display layer titles edit events from `targets` when present.
      targets: changes.map((c) => c?.path).filter(Boolean),
      output: '',
      error: failed ? (item.error ?? 'failed') : null,
      event,
    };
  }
  if (type === 'web_search') {
    return {
      name: 'web_search',
      status: failed ? 'error' : 'completed',
      input: item.query ?? null,
      output: '',
      error: failed ? (item.error ?? 'failed') : null,
      event,
    };
  }
  return null;
};

export const createCodexJsonlParser = ({
  onText = () => {},
  onTool = () => {},
  onError = () => {},
  onSession = () => {},
  onUsage = () => {},
  onDiagnostic = () => {},
} = {}) => {
  let pending = '';
  const state = {
    text: '',
    sessionId: null,
    metrics: null,
    errors: [],
    diagnostics: [],
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

    const sessionId = event?.thread_id ?? event?.threadId ?? null;
    if (!state.sessionId && sessionId) {
      state.sessionId = String(sessionId);
      onSession(state.sessionId);
    }

    if (type === 'item.completed') {
      const item = event?.item ?? {};
      const itemType = String(item?.type ?? '');
      if (itemType === 'agent_message' && typeof item.text === 'string') {
        state.text += item.text;
        onText(item.text, event);
        return;
      }
      const tool = toolOf(item, event);
      if (tool) {
        onTool(tool);
        return;
      }
      // Reasoning summaries, plan updates, unknown item kinds — keep as
      // hidden context, not user-facing messages.
      const summary =
        typeof item.text === 'string' ? `${itemType}: ${item.text}` : JSON.stringify(item);
      state.diagnostics.push(summary);
      onDiagnostic(summary);
      return;
    }

    if (type === 'turn.completed') {
      const metrics = usageFrom(event);
      if (metrics) {
        state.metrics = { ...state.metrics, ...metrics };
        onUsage(metrics, event);
      }
      return;
    }

    if (type === 'turn.failed' || type === 'error') {
      const message = String(errorMessage(event));
      state.errors.push(message);
      onError(message, event);
      return;
    }

    // thread.started (already consumed above), turn.started, item.started,
    // item.updated, and anything new — ignore quietly; only COMPLETED items
    // are rendered so events are never double-reported.
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
      return state;
    },
  };
};

export const parseCodexJsonl = (stdout = '') => {
  const parser = createCodexJsonlParser();
  parser.write(stdout);
  return parser.flush();
};

export const __test = { usageFrom, toolOf, errorMessage };
