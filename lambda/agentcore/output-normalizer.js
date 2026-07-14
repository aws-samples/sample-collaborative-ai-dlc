const TOOL_DISPLAY_TYPES = new Set([
  'message',
  'tool',
  'batch_read',
  'artifact',
  'question',
  'system',
  'raw',
]);

const normalizeDisplay = (display) => {
  if (!display || typeof display !== 'object') return undefined;
  const type = TOOL_DISPLAY_TYPES.has(display.type) ? display.type : 'message';
  return {
    type,
    ...(display.level ? { level: display.level } : {}),
    ...(display.title ? { title: display.title } : {}),
    ...(display.summary ? { summary: display.summary } : {}),
    ...(display.details ? { details: display.details } : {}),
    ...(display.hiddenByDefault ? { hiddenByDefault: true } : {}),
  };
};

export const textFromClaudeStreamEvent = (event) => {
  if (!event || typeof event !== 'object') return '';
  if (event.type === 'content_block_delta') return event.delta?.text ?? '';
  if (event.type === 'content_block_start') return event.content_block?.text ?? '';
  if (event.type === 'text') return event.text ?? '';
  if (event.type === 'assistant' && Array.isArray(event.message?.content)) {
    return event.message.content
      .filter((part) => part?.type === 'text' && typeof part.text === 'string')
      .map((part) => part.text)
      .join('');
  }
  return '';
};

export const stripTerminalControls = (text = '') => {
  const s = String(text);
  let out = '';
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i);
    const next = s[i + 1];

    if (code === 27 && next === ']') {
      i += 2;
      for (; i < s.length; i += 1) {
        if (s.charCodeAt(i) === 7) break;
        if (s.charCodeAt(i) === 27 && s[i + 1] === '\\') {
          i += 1;
          break;
        }
      }
      continue;
    }

    if ((code === 27 && next === '[') || code === 155) {
      if (code === 27) i += 1;
      for (i += 1; i < s.length; i += 1) {
        const final = s.charCodeAt(i);
        if (final >= 64 && final <= 126) break;
      }
      continue;
    }

    if ((code < 32 && code !== 9 && code !== 10 && code !== 13) || code === 127) continue;
    out += s[i];
  }

  // Some CLIs print ANSI CSI fragments through layers that drop ESC but leave
  // `[38;5;141m` / `[0m` behind. Remove those orphaned color fragments too.
  return out.replace(/\[(?:\d{1,3}(?:;\d{1,3})*)?m/g, '');
};

const emitEvent = (emit, content, display) => {
  if (!content) return;
  emit({ content, display: normalizeDisplay(display) });
};

const completionOf = (line) => {
  const match = line.match(
    /^\s*-?\s*(Completed|Failed|Errored|Error)(?:\s+in\s+([0-9.]+\s*[a-z]+))?\s*$/i,
  );
  if (!match) return null;
  const word = match[1].toLowerCase();
  return {
    ok: word === 'completed',
    duration: match[2]?.replace(/\s+/g, '') ?? null,
  };
};

const parseToolStart = (line) => {
  const match = line.match(/^\s*Running tool\s+[`'"]?([A-Za-z0-9_.:-]+)\b/i);
  return match?.[1] ?? null;
};

const extractJson = (text) => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(text.slice(start, end + 1));
  } catch {
    return null;
  }
};

const extractParamString = (text, keys) => {
  for (const key of keys) {
    const quoted = new RegExp(`["']${key}["']\\s*:\\s*["']([^"']+)["']`, 'i').exec(text);
    if (quoted?.[1]) return quoted[1];
    const bare = new RegExp(`\\b${key}\\b\\s*:\\s*([^,}\\]\\s]+)`, 'i').exec(text);
    if (bare?.[1]) return bare[1].replace(/^["']|["']$/g, '');
  }
  return '';
};

const basenameish = (value) => {
  const trimmed = String(value ?? '').trim();
  if (!trimmed) return '';
  const clean = trimmed.replace(/\/+$/g, '');
  return clean.split('/').filter(Boolean).pop() || clean;
};

const compactList = (items, max = 3) => {
  const names = items.map(basenameish).filter(Boolean);
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} +${names.length - max}`;
};

const readTargetsFromParams = (params) => {
  if (!params || typeof params !== 'object') return [];
  const raw =
    params.path ??
    params.paths ??
    params.file ??
    params.files ??
    params.filename ??
    params.pattern ??
    params.glob;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw) return [String(raw)];
  return [];
};

const readTargetsFromTool = (tool, params) => {
  const fromParams = readTargetsFromParams(params);
  if (fromParams.length) return fromParams;
  const value = extractParamString(tool.rawLines.join(''), [
    'path',
    'paths',
    'file',
    'files',
    'filename',
    'pattern',
    'glob',
  ]);
  return value ? [value] : [];
};

const artifactLabelFromParams = (params) => {
  if (!params || typeof params !== 'object') return '';
  return String(params.id ?? params.artifactId ?? params.artifactType ?? params.name ?? '').trim();
};

const artifactLabelFromTool = (tool, params) =>
  artifactLabelFromParams(params) ||
  extractParamString(tool.rawLines.join(''), ['id', 'artifactId', 'artifactType', 'name']);

const humanizeTool = (name) =>
  String(name || 'tool')
    .replace(/[_:-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const displayForTool = (tool) => {
  const content = tool.rawLines.join('');
  const params = extractJson(content);
  const completion = tool.completion ?? { ok: false, duration: null };
  const failed = !completion.ok;
  const details = failed ? content.trim() : undefined;
  const duration = completion.duration ? `Completed in ${completion.duration}` : undefined;

  if (tool.name === 'emit_stage_note') {
    return {
      content,
      display: {
        type: 'system',
        level: failed ? 'error' : 'info',
        title: failed ? 'Stage note failed' : 'Stage note recorded',
        summary: failed ? 'The stage note tool failed.' : 'Stage note recorded',
        details,
        hiddenByDefault: !failed,
      },
    };
  }

  if (tool.name === 'get_artifact' || tool.name === 'get_artifact_toc') {
    const label = artifactLabelFromTool(tool, params) || 'artifact';
    return {
      content,
      display: {
        type: 'artifact',
        level: failed ? 'error' : 'info',
        title: failed ? `Artifact load failed: ${label}` : `Loaded artifact: ${label}`,
        summary: failed ? 'Artifact read failed.' : duration,
        details,
        hiddenByDefault: false,
      },
    };
  }

  if (tool.name === 'create_artifact') {
    const label = artifactLabelFromTool(tool, params) || 'artifact';
    return {
      content,
      display: {
        type: 'artifact',
        level: failed ? 'error' : 'info',
        title: failed ? `Artifact write failed: ${label}` : `Created artifact: ${label}`,
        summary: failed ? 'Artifact write failed.' : duration,
        details,
        hiddenByDefault: false,
      },
    };
  }

  if (tool.name === 'ask_question') {
    return {
      content,
      display: {
        type: 'question',
        level: failed ? 'error' : 'info',
        title: failed ? 'Question failed' : 'Asked a question',
        summary: failed ? 'The question tool failed.' : duration,
        details,
        hiddenByDefault: false,
      },
    };
  }

  const title = failed ? `${humanizeTool(tool.name)} failed` : humanizeTool(tool.name);
  return {
    content,
    display: {
      type: 'tool',
      level: failed ? 'error' : 'info',
      title,
      summary: failed ? 'Tool call failed.' : duration,
      details,
      hiddenByDefault: !failed,
    },
  };
};

const displayForReadBatch = (tools) => {
  const content = tools.map((t) => t.rawLines.join('')).join('');
  const targets = tools.flatMap((t) => readTargetsFromTool(t, extractJson(t.rawLines.join(''))));
  const names = compactList(targets.length ? targets : tools.map((_, i) => `item ${i + 1}`));
  const count = tools.length;
  return {
    content,
    display: {
      type: 'batch_read',
      level: 'info',
      title: `Read ${count} workspace ${count === 1 ? 'item' : 'items'}${names ? `: ${names}` : ''}`,
      summary: `${count} ${count === 1 ? 'read' : 'reads'}`,
      hiddenByDefault: false,
    },
  };
};

const isStructuralNoiseLine = (text) => {
  const s = String(text ?? '').trim();
  if (!s) return true;
  if (/^stdout$/i.test(s)) return true;
  if (/^Running tool\b/i.test(s)) return true;
  if (/^[-\s]*(Completed|Failed|Errored|Error)\b/i.test(s)) return true;
  const stripped = s.replace(/^[.:…⋮\s]+/, '').trim();
  if (/^[{}[\],]+$/.test(stripped)) return true;
  if (/^"[^"]+"\s*:/.test(stripped)) return true;
  if (/^[{[]\s*"[^"]+"\s*:/.test(stripped)) return true;
  return false;
};

export const createCliOutputSink = ({ cli, emit }) => {
  let pending = '';

  if (cli !== 'claude') {
    let suppressTool = false;
    let tool = null;
    let readBatch = [];

    const flushReadBatch = () => {
      if (!readBatch.length) return;
      const event = displayForReadBatch(readBatch);
      readBatch = [];
      emitEvent(emit, event.content, event.display);
    };

    const flushToolAsRaw = () => {
      if (!tool) return;
      const content = tool.rawLines.join('');
      tool = null;
      flushReadBatch();
      emitEvent(emit, content, {
        type: 'raw',
        level: 'info',
        summary: content.trim(),
      });
    };

    const finishTool = (completion) => {
      if (!tool) return;
      tool.completion = completion;
      const finished = tool;
      tool = null;
      if (finished.name === 'fs_read' && completion.ok) {
        readBatch.push(finished);
        return;
      }
      flushReadBatch();
      const event = displayForTool(finished);
      emitEvent(emit, event.content, event.display);
    };

    const consumeLine = (line, newline = true) => {
      const text = stripTerminalControls(`${line}${newline ? '\n' : ''}`);
      const toolName = parseToolStart(text);

      if (suppressTool) {
        if (completionOf(text)) suppressTool = false;
        return;
      }

      if (toolName) {
        flushToolAsRaw();
        if (toolName === 'send_output') {
          suppressTool = true;
          return;
        }
        tool = { name: toolName, rawLines: [text], completion: null };
        return;
      }

      if (tool) {
        tool.rawLines.push(text);
        const completion = completionOf(text);
        if (completion) finishTool(completion);
        return;
      }

      if (text.trim()) {
        flushReadBatch();
        const structural = isStructuralNoiseLine(text);
        emitEvent(emit, text, {
          type: structural ? 'raw' : 'message',
          level: 'info',
          summary: text.trim(),
          hiddenByDefault: structural,
        });
      }
    };

    return {
      write(chunk) {
        pending += chunk;
        const lines = pending.split(/\r?\n/);
        pending = lines.pop() ?? '';
        for (const line of lines) consumeLine(line);
      },
      flush() {
        if (pending) consumeLine(pending, false);
        pending = '';
        flushToolAsRaw();
        flushReadBatch();
      },
    };
  }

  // Claude's stream-json is JSONL. Forward only human-readable assistant text,
  // not the transport/tool metadata lines.
  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      const text = stripTerminalControls(textFromClaudeStreamEvent(JSON.parse(line)));
      if (text) {
        emitEvent(emit, text, { type: 'message', level: 'info', summary: text.trim() });
      }
    } catch {
      // If the CLI ever prints non-JSON diagnostics on stdout, keep them visible.
      const text = stripTerminalControls(`${line}\n`);
      emitEvent(emit, text, { type: 'raw', level: 'info', summary: text.trim() });
    }
  };

  return {
    write(chunk) {
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? '';
      for (const line of lines) consumeLine(line);
    },
    flush() {
      if (pending) consumeLine(pending);
      pending = '';
    },
  };
};

export const __test = {
  displayForTool,
  displayForReadBatch,
  extractJson,
  isStructuralNoiseLine,
};
