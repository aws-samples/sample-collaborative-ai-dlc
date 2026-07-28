import { createOpenCodeJsonlParser } from './cli/opencode-parser.js';
import { createCodexJsonlParser } from './cli/codex-parser.js';

const TOOL_DISPLAY_TYPES = new Set([
  'message',
  'tool',
  'edit',
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

const cleanDisplayMessage = (text) =>
  String(text ?? '')
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*>\s?/, '').replace(/^\s*[\u2713\u2714]\s*/, ''))
    .join('\n')
    .trim();

const displayForMessage = (content) => {
  const summary = cleanDisplayMessage(content);
  const success =
    /^Stage complete\b/i.test(summary) ||
    /^Local \S+ cold resume completed\.?$/i.test(summary) ||
    /\bfinished successfully\.?$/i.test(summary);
  return {
    type: success ? 'system' : 'message',
    level: success ? 'success' : 'info',
    ...(success ? { title: summary } : { summary }),
  };
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

const parseNativeFsStart = (line) => {
  const read = line.match(
    /^\s*Reading file:\s*(.+?)(?:,\s*all lines)?\s*\(using tool:\s*read\)\s*$/i,
  );
  if (read?.[1]) {
    return {
      name: 'fs_read',
      targets: [read[1].trim()],
    };
  }

  const write = line.match(
    /^\s*I'll\s+(create|update|modify|edit|write)\s+the following file:\s*(.+?)\s*\(using tool:\s*(?:write|edit)\)\s*$/i,
  );
  if (!write?.[2]) return null;
  const operation = write[1].toLowerCase();
  return {
    name: 'fs_write',
    targets: [write[2].trim()],
    editAction: operation === 'create' ? 'Created' : operation === 'write' ? 'Wrote' : 'Updated',
  };
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
    params.file_path ??
    params.filePath ??
    params.filename ??
    params.pattern ??
    params.glob;
  if (Array.isArray(raw)) return raw.map(String).filter(Boolean);
  if (raw) return [String(raw)];
  return [];
};

const readTargetsFromTool = (tool, params) => {
  if (Array.isArray(tool.targets) && tool.targets.length) return tool.targets;
  const fromParams = readTargetsFromParams(params);
  if (fromParams.length) return fromParams;
  const value = extractParamString(tool.rawLines.join(''), [
    'path',
    'paths',
    'file',
    'files',
    'file_path',
    'filePath',
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

const artifactTitleFromTool = (tool, params) =>
  String(params?.title ?? '').trim() ||
  extractParamString(tool.rawLines.join(''), ['title']) ||
  artifactLabelFromTool(tool, params);

const questionTextFromTool = (tool, params) => {
  const question = Array.isArray(params?.questions) ? params.questions[0] : null;
  return (
    String(question?.text ?? '').trim() ||
    extractParamString(tool.rawLines.join(''), ['text', 'question'])
  );
};

const humanizeTool = (name) =>
  String(name || 'tool')
    .replace(/[_:-]+/g, ' ')
    .replace(/\b\w/g, (c) => c.toUpperCase());

const isEditTool = (name) =>
  /^(?:fs_)?(?:write|edit|replace|patch)(?:_file)?$/i.test(String(name ?? '')) ||
  /^(?:apply_patch|str_replace|multi_edit|notebook_edit|create_file)$/i.test(String(name ?? ''));

const patchDelta = (content) => {
  const lines = String(content ?? '').split(/\r?\n/);
  const additions = lines.filter((line) => /^\s*\+\s*\d+:\s?/.test(line)).length;
  const deletions = lines.filter((line) => /^\s*-\s*\d+:\s?/.test(line)).length;
  if (!additions && !deletions) return '';
  if (additions && !deletions) return `+${additions} ${additions === 1 ? 'line' : 'lines'}`;
  if (!additions && deletions) return `-${deletions} ${deletions === 1 ? 'line' : 'lines'}`;
  return `+${additions}/-${deletions} lines`;
};

const editActionForTool = (tool, content) => {
  if (tool.editAction) return tool.editAction;
  if (/^create_file$/i.test(tool.name)) return 'Created';
  if (/\bFile created successfully\b|\bCreating:\s/i.test(content)) return 'Created';
  if (/^(?:fs_)?write(?:_file)?$/i.test(tool.name)) return 'Wrote';
  return 'Updated';
};

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
    const label = artifactTitleFromTool(tool, params) || 'artifact';
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
    const question = questionTextFromTool(tool, params);
    return {
      content,
      display: {
        type: 'question',
        level: failed ? 'error' : 'info',
        title: failed ? 'Question failed' : question ? `Question: ${question}` : 'Asked a question',
        summary: failed ? 'The question tool failed.' : duration,
        details,
        hiddenByDefault: false,
      },
    };
  }

  if (isEditTool(tool.name)) {
    const targets = readTargetsFromTool(tool, params);
    const names = compactList(targets);
    const target = names ? `: ${names}` : '';
    const delta = patchDelta(content);
    const deltaSuffix = delta ? ` (${delta})` : '';
    const action = editActionForTool(tool, content);
    return {
      content,
      display: {
        type: 'edit',
        level: failed ? 'error' : 'info',
        title: failed ? `Edit failed${target}` : `${action}${target}${deltaSuffix}`,
        summary: failed ? 'Workspace edit failed.' : duration,
        details: content.trim(),
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

const isPatchLine = (text) => /^\s*[+-]\s*\d+:\s?/.test(String(text ?? ''));

const openCodeToolName = (name) => {
  const raw = String(name ?? 'tool')
    .split(/[.:]/)
    .at(-1);
  return raw.startsWith('aidlc_') ? raw.slice('aidlc_'.length) : raw;
};

const claudeToolName = (name) => {
  const raw = String(name ?? 'tool');
  return raw.startsWith('mcp__') ? raw.split('__').at(-1) : raw;
};

const claudeResultText = (result) => {
  if (typeof result?.content === 'string') return result.content;
  if (!Array.isArray(result?.content)) return '';
  return result.content
    .map((part) => (typeof part === 'string' ? part : (part?.text ?? '')))
    .filter(Boolean)
    .join('\n');
};

export const createCliOutputSink = ({
  cli,
  emit,
  onSession = () => {},
  onUsage = () => {},
  onError: handleError = () => {},
}) => {
  let pending = '';

  if (cli === 'opencode') {
    const parser = createOpenCodeJsonlParser({
      onSession,
      onUsage,
      onText(text) {
        const content = stripTerminalControls(text);
        emitEvent(emit, content, displayForMessage(content));
      },
      onTool(toolEvent) {
        const name = openCodeToolName(toolEvent.name);
        // send_output already persists its canonical output through MCP.
        if (name === 'send_output') return;
        const rawLines = [
          `Running tool ${name}\n`,
          `${JSON.stringify(toolEvent.input ?? {})}\n`,
          ...(toolEvent.output ? [`${String(toolEvent.output)}\n`] : []),
          ...(toolEvent.error ? [`${String(toolEvent.error?.message ?? toolEvent.error)}\n`] : []),
        ];
        const event = displayForTool({
          name,
          rawLines,
          completion: { ok: toolEvent.status === 'completed', duration: null },
        });
        emitEvent(emit, event.content, event.display);
      },
      onError(message, event) {
        handleError(message, event);
        const content = stripTerminalControls(`${message}\n`);
        emitEvent(emit, content, {
          type: 'raw',
          level: 'error',
          title: 'OpenCode error',
          summary: content.trim(),
          details: content.trim(),
        });
      },
      onDiagnostic(line) {
        const content = stripTerminalControls(`${line}\n`);
        emitEvent(emit, content, {
          type: 'raw',
          level: 'info',
          summary: content.trim(),
          hiddenByDefault: true,
        });
      },
    });
    return {
      state: parser.state,
      write(chunk) {
        parser.write(chunk);
      },
      flush() {
        return parser.flush();
      },
    };
  }

  if (cli === 'codex') {
    const parser = createCodexJsonlParser({
      onSession,
      onUsage,
      onText(text) {
        const content = stripTerminalControls(text);
        emitEvent(emit, content, displayForMessage(content));
      },
      onTool(toolEvent) {
        // Codex reports MCP tools with the bare tool name (server carried
        // separately) — no prefix stripping needed.
        const name = String(toolEvent.name ?? 'tool');
        // send_output already persists its canonical output through MCP.
        if (name === 'send_output') return;
        const rawLines = [
          `Running tool ${name}\n`,
          `${JSON.stringify(toolEvent.input ?? {})}\n`,
          ...(toolEvent.output ? [`${String(toolEvent.output)}\n`] : []),
          ...(toolEvent.error ? [`${String(toolEvent.error?.message ?? toolEvent.error)}\n`] : []),
        ];
        const event = displayForTool({
          name,
          rawLines,
          ...(Array.isArray(toolEvent.targets) && toolEvent.targets.length
            ? { targets: toolEvent.targets }
            : {}),
          completion: { ok: toolEvent.status === 'completed', duration: null },
        });
        emitEvent(emit, event.content, event.display);
      },
      onError(message, event) {
        handleError(message, event);
        const content = stripTerminalControls(`${message}\n`);
        emitEvent(emit, content, {
          type: 'raw',
          level: 'error',
          title: 'Codex error',
          summary: content.trim(),
          details: content.trim(),
        });
      },
      onDiagnostic(line) {
        const content = stripTerminalControls(`${line}\n`);
        emitEvent(emit, content, {
          type: 'raw',
          level: 'info',
          summary: content.trim(),
          hiddenByDefault: true,
        });
      },
    });
    return {
      state: parser.state,
      write(chunk) {
        parser.write(chunk);
      },
      flush() {
        return parser.flush();
      },
    };
  }

  if (cli !== 'claude') {
    let suppressTool = false;
    let tool = null;
    let readBatch = [];
    let messageLines = [];
    let patchLines = [];

    const flushReadBatch = () => {
      if (!readBatch.length) return;
      const event = displayForReadBatch(readBatch);
      readBatch = [];
      emitEvent(emit, event.content, event.display);
    };

    const flushMessage = () => {
      if (!messageLines.length) return;
      const content = messageLines.join('');
      messageLines = [];
      emitEvent(emit, content, displayForMessage(content));
    };

    const flushPatch = () => {
      if (!patchLines.length) return;
      const content = patchLines.join('');
      const lineCount = patchLines.length;
      patchLines = [];
      emitEvent(emit, content, {
        type: 'edit',
        level: 'info',
        title: `Updated ${lineCount} ${lineCount === 1 ? 'line' : 'lines'}`,
        details: content.trim(),
        hiddenByDefault: false,
      });
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
      const nativeFs = parseNativeFsStart(text);

      if (suppressTool) {
        if (completionOf(text)) suppressTool = false;
        return;
      }

      if (toolName || nativeFs) {
        flushMessage();
        flushPatch();
        flushToolAsRaw();
        if (toolName === 'send_output') {
          suppressTool = true;
          return;
        }
        tool = {
          name: toolName ?? nativeFs.name,
          rawLines: [text],
          completion: null,
          ...nativeFs,
        };
        return;
      }

      if (tool) {
        tool.rawLines.push(text);
        const completion = completionOf(text);
        if (completion) finishTool(completion);
        return;
      }

      if (!text.trim()) {
        flushMessage();
        flushPatch();
        return;
      }

      flushReadBatch();
      if (isPatchLine(text)) {
        flushMessage();
        patchLines.push(text);
        return;
      }

      flushPatch();
      const structural = isStructuralNoiseLine(text);
      if (structural) {
        flushMessage();
        emitEvent(emit, text, {
          type: 'raw',
          level: 'info',
          summary: text.trim(),
          hiddenByDefault: true,
        });
      } else {
        messageLines.push(text);
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
        flushMessage();
        flushPatch();
        flushReadBatch();
      },
    };
  }

  // Claude's stream-json is JSONL. Forward only human-readable assistant text,
  // plus completed tool calls paired by tool_use id.
  const pendingTools = new Map();
  const consumeLine = (line) => {
    if (!line.trim()) return;
    try {
      const event = JSON.parse(line);
      const text = stripTerminalControls(textFromClaudeStreamEvent(event));
      if (text) {
        emitEvent(emit, text, displayForMessage(text));
      }
      const parts = Array.isArray(event?.message?.content) ? event.message.content : [];
      if (event.type === 'assistant') {
        for (const part of parts) {
          if (part?.type !== 'tool_use' || !part.id) continue;
          pendingTools.set(part.id, {
            name: claudeToolName(part.name),
            input: part.input ?? {},
          });
        }
      }
      if (event.type === 'user') {
        for (const part of parts) {
          if (part?.type !== 'tool_result' || !part.tool_use_id) continue;
          const started = pendingTools.get(part.tool_use_id);
          if (!started) continue;
          pendingTools.delete(part.tool_use_id);
          if (started.name === 'send_output') continue;
          const output = claudeResultText(part);
          const rawLines = [
            `Running tool ${started.name}\n`,
            `${JSON.stringify(started.input)}\n`,
            ...(output ? [`${output}\n`] : []),
          ];
          const normalized = displayForTool({
            name: started.name,
            rawLines,
            completion: { ok: part.is_error !== true, duration: null },
          });
          emitEvent(emit, normalized.content, normalized.display);
        }
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
  isEditTool,
  isPatchLine,
  isStructuralNoiseLine,
  openCodeToolName,
};
