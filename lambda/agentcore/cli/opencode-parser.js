// Incremental parser for `opencode run --format json` JSONL output.
//
// OpenCode emits one completed part per line. The parser accepts arbitrarily
// split chunks, captures the first session id, reports completed text/tool
// parts, surfaces actionable errors, and folds step-finish usage into the
// metric names used by the process store.

const numberOrNull = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

const firstNumber = (...values) => {
  for (const value of values) {
    const n = numberOrNull(value);
    if (n !== null) return n;
  }
  return null;
};

const usageFrom = (event) => {
  const part = event?.part ?? {};
  const tokens = part.tokens ?? event?.tokens ?? event?.usage ?? {};
  const cache = tokens.cache ?? {};
  const fields = {
    tokensInput: firstNumber(tokens.input, tokens.input_tokens),
    tokensOutput: firstNumber(tokens.output, tokens.output_tokens),
    tokensReasoning: firstNumber(tokens.reasoning, tokens.reasoning_tokens),
    tokensCacheRead: firstNumber(
      cache.read,
      tokens.cache_read,
      tokens.cache_read_input_tokens,
      tokens.cache_read_tokens,
    ),
    tokensCacheWrite: firstNumber(
      cache.write,
      tokens.cache_write,
      tokens.cache_creation_input_tokens,
      tokens.cache_write_tokens,
    ),
    cost: firstNumber(part.cost, event?.cost),
  };
  const metrics = Object.fromEntries(
    Object.entries(fields).filter(([, value]) => value !== null && value >= 0),
  );
  return Object.keys(metrics).length ? metrics : null;
};

const errorMessage = (event) => {
  const error = event?.error ?? event?.part?.state?.error ?? event?.part?.error ?? event?.message;
  if (typeof error === 'string') return error;
  return (
    error?.data?.message ??
    error?.message ??
    error?.name ??
    event?.part?.state?.output ??
    'OpenCode reported an error'
  );
};

const sessionIdOf = (event) =>
  event?.sessionID ??
  event?.sessionId ??
  event?.session_id ??
  event?.part?.sessionID ??
  event?.part?.sessionId ??
  null;

const toolOf = (event) => {
  const part = event?.part ?? {};
  const state = part.state ?? event?.state ?? {};
  const status = String(state.status ?? event?.status ?? '').toLowerCase();
  const eventType = String(event?.type ?? '')
    .replaceAll('-', '_')
    .toLowerCase();
  const partType = String(part.type ?? '')
    .replaceAll('-', '_')
    .toLowerCase();
  if (eventType !== 'tool_use' && partType !== 'tool') return null;
  if (!['completed', 'error', 'failed'].includes(status)) return null;
  return {
    name: part.tool ?? event?.tool ?? 'tool',
    status: status === 'completed' ? 'completed' : 'error',
    input: state.input ?? part.input ?? event?.input ?? null,
    output: state.output ?? part.output ?? event?.output ?? '',
    error: state.error ?? part.error ?? event?.error ?? null,
    event,
  };
};

export const createOpenCodeJsonlParser = ({
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

    const sessionId = sessionIdOf(event);
    if (!state.sessionId && sessionId) {
      state.sessionId = String(sessionId);
      onSession(state.sessionId);
    }

    const type = String(event?.type ?? '')
      .replaceAll('-', '_')
      .toLowerCase();
    const part = event?.part ?? {};
    const partType = String(part.type ?? '')
      .replaceAll('-', '_')
      .toLowerCase();
    if ((type === 'text' || partType === 'text') && typeof part.text === 'string') {
      state.text += part.text;
      onText(part.text, event);
    } else if (type === 'text' && typeof event.text === 'string') {
      state.text += event.text;
      onText(event.text, event);
    }

    const tool = toolOf(event);
    if (tool) onTool(tool);

    if (
      !tool &&
      (type === 'error' ||
        partType === 'error' ||
        ['error', 'failed'].includes(String(part?.state?.status ?? '').toLowerCase()))
    ) {
      const message = String(errorMessage(event));
      state.errors.push(message);
      onError(message, event);
    }

    if (type === 'step_finish' || partType === 'step_finish') {
      const metrics = usageFrom(event);
      if (metrics) {
        state.metrics = { ...state.metrics, ...metrics };
        onUsage(metrics, event);
      }
    }
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

export const parseOpenCodeJsonl = (stdout = '') => {
  const parser = createOpenCodeJsonlParser();
  parser.write(stdout);
  return parser.flush();
};

export const __test = { usageFrom, sessionIdOf, toolOf, errorMessage };
