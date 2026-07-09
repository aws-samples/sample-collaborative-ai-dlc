// Validates a custom MCP server config in our author format — a JSON OBJECT
// keyed by server name (like a CLI's `mcpServers` block, minus the wrapper):
//   { "aws-mcp": { "command": "uvx", "args": [...] }, "other": { ... } }
// This is NOT a CLI's on-disk format; toMcpServerMap transforms it into each
// CLI's target shape (Claude `--mcp-config` / Kiro agent config), emitting only
// keys that CLI accepts so we never write an entry it would reject.
//
// Entry value (the server name is the object key):
//   stdio:    { command, args?: string[], env?: { KEY: "value" } }
//   http/sse: { type: "http"|"sse", url, headers?: { KEY: "value" } }
//
// The reserved names `aidlc`/`workspace` are rejected so a custom entry can
// never shadow the runtime's own MCP server.
//
// Strict mode: unknown keys are rejected — the format is intentionally the safe
// intersection both CLIs support (no CLI-specific extras like Kiro's autoApprove
// or Claude's headersHelper), so an unknown key is a user mistake.

const ALLOWED_TYPES = new Set(['stdio', 'http', 'sse']);
const STDIO_ALLOWED_KEYS = new Set(['type', 'command', 'args', 'env']);
const HTTP_ALLOWED_KEYS = new Set(['type', 'url', 'headers']);

// Bare-command guard for stdio servers: a command with no path separator must
// be a launcher/interpreter installed in the v2 AgentCore image (see
// lambda/agentcore/Dockerfile). Catches typos (`uvxx`) and commands the image
// doesn't ship. A command containing `/` (absolute/relative path) is allowed
// through — the operator vouches for it. NOTE: this is a misconfiguration guard,
// not a security boundary (`npx`/`uvx` can run arbitrary packages).
const KNOWN_AGENT_IMAGE_MCP_COMMANDS = new Set([
  'node',
  'npx',
  'bun',
  'bunx',
  'uv',
  'uvx',
  'python',
  'python3',
]);

// The runtime-managed MCP server name (see agentcore stage-materializer). A
// custom entry using this name would collide with the process bridge.
// `workspace` is additionally reserved by Claude Code for internal use
// (https://code.claude.com/docs/en/mcp — "The server name `workspace` is
// reserved for internal use").
const RESERVED_SERVER_NAME = 'aidlc';
const RESERVED_SERVER_NAMES = new Set([RESERVED_SERVER_NAME, 'workspace']);

const MAX_SERVERS = 20;

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

// Validate a native env/headers object: a plain object of string → string.
function validateStringMap(obj, path, issues, kind) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    issues.push({
      path,
      message: `Expected ${kind} to be an object of string values (e.g. {"KEY":"value"}); got ${describe(obj)}.`,
    });
    return;
  }
  for (const [key, value] of Object.entries(obj)) {
    if (typeof value !== 'string') {
      issues.push({
        path: `${path}.${key}`,
        message: `Expected string; got ${describe(value)}.`,
      });
    }
  }
}

function validateStdio(server, path, issues) {
  for (const key of Object.keys(server)) {
    if (!STDIO_ALLOWED_KEYS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `Unknown key "${key}" for stdio MCP server. Allowed: ${[...STDIO_ALLOWED_KEYS].join(', ')}.`,
      });
    }
  }
  if (typeof server.command !== 'string' || server.command.length === 0) {
    issues.push({
      path: `${path}.command`,
      message: 'Required non-empty string (the MCP server executable, e.g. "npx").',
    });
  } else if (!server.command.includes('/') && !KNOWN_AGENT_IMAGE_MCP_COMMANDS.has(server.command)) {
    issues.push({
      path: `${path}.command`,
      message: `Unknown executable "${server.command}". Use an absolute path or one of: ${[
        ...KNOWN_AGENT_IMAGE_MCP_COMMANDS,
      ].join(', ')}.`,
    });
  }
  if (server.args !== undefined) {
    if (!Array.isArray(server.args)) {
      issues.push({
        path: `${path}.args`,
        message: `Expected array of strings (omit or use [] if none); got ${describe(server.args)}.`,
      });
    } else {
      server.args.forEach((arg, i) => {
        if (typeof arg !== 'string') {
          issues.push({
            path: `${path}.args[${i}]`,
            message: `Expected string; got ${describe(arg)}.`,
          });
        }
      });
    }
  }
  if (server.env !== undefined) {
    validateStringMap(server.env, `${path}.env`, issues, 'env');
  }
}

function validateHttpOrSse(server, path, issues, type) {
  for (const key of Object.keys(server)) {
    if (!HTTP_ALLOWED_KEYS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `Unknown key "${key}" for ${type} MCP server. Allowed: ${[...HTTP_ALLOWED_KEYS].join(', ')}.`,
      });
    }
  }
  if (typeof server.url !== 'string' || server.url.length === 0) {
    issues.push({ path: `${path}.url`, message: 'Required non-empty string.' });
  } else {
    let parsed;
    try {
      parsed = new URL(server.url);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      issues.push({ path: `${path}.url`, message: `Invalid URL: "${server.url}".` });
    } else if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      // Remote MCP endpoints are HTTP(S) only (Kiro/Claude). Reject file:, ftp:,
      // etc. — a parseable URL is not sufficient.
      issues.push({
        path: `${path}.url`,
        message: `URL must use http:// or https:// (got "${parsed.protocol}//").`,
      });
    }
  }
  if (server.headers !== undefined) {
    validateStringMap(server.headers, `${path}.headers`, issues, 'headers');
  }
}

function validateServer(server, path, issues) {
  if (server === null || typeof server !== 'object' || Array.isArray(server)) {
    issues.push({ path, message: `Expected an object; got ${describe(server)}.` });
    return;
  }
  // Determine transport. Default: stdio (matches Claude/Kiro). Reject unknown
  // values. A `url` with no `type` is a common mistake — both Claude and Kiro
  // treat a typeless entry as stdio, so it would fail as "missing command";
  // surface a clearer, actionable message instead.
  let type = server.type;
  if (type === undefined) {
    if (server && typeof server === 'object' && 'url' in server) {
      issues.push({
        path: `${path}.type`,
        message: 'Remote servers require an explicit "type" of "http" or "sse" alongside "url".',
      });
      return;
    }
    type = 'stdio';
  } else if (typeof type !== 'string' || !ALLOWED_TYPES.has(type)) {
    issues.push({
      path: `${path}.type`,
      message: `Expected one of "stdio", "http", "sse"; got ${JSON.stringify(server.type)}.`,
    });
    return; // can't validate further without a known transport
  }
  if (type === 'stdio') validateStdio(server, path, issues);
  else validateHttpOrSse(server, path, issues, type);
}

/**
 * Validate a parsed custom MCP servers value (already-parsed JSON, expected to
 * be an OBJECT keyed by server name). Returns `{ valid, issues }`.
 *
 * Issues have the shape `{ path, message }` where `path` is a JSON-ish locator
 * like `aws-mcp.env.TOKEN` so the UI can point at the exact field.
 */
function validateMcpServers(value) {
  const issues = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    issues.push({
      path: '',
      message: `Expected a JSON object of MCP servers keyed by name; got ${describe(value)}.`,
    });
    return { valid: false, issues };
  }
  const names = Object.keys(value);
  if (names.length > MAX_SERVERS) {
    issues.push({
      path: '',
      message: `Too many MCP servers (${names.length}). Maximum is ${MAX_SERVERS}.`,
    });
  }
  for (const name of names) {
    if (name.length === 0) {
      issues.push({ path: name, message: 'Server name must be a non-empty string.' });
      continue;
    }
    if (RESERVED_SERVER_NAMES.has(name)) {
      issues.push({
        path: name,
        message: `"${name}" is a reserved server name and cannot be used.`,
      });
      continue;
    }
    validateServer(value[name], name, issues);
  }
  return { valid: issues.length === 0, issues };
}

/**
 * Convenience wrapper that accepts the raw JSON string the API receives.
 * Returns `{ valid, issues }`. If the string is not valid JSON, returns a
 * single issue at the root.
 */
function validateMcpServersJson(jsonString) {
  let parsed;
  try {
    parsed = JSON.parse(jsonString);
  } catch (err) {
    return {
      valid: false,
      issues: [{ path: '', message: `Invalid JSON: ${err.message}.` }],
    };
  }
  return validateMcpServers(parsed);
}

/**
 * Transform a validated MCP servers OBJECT (keyed by name — our author format)
 * into the target CLI's `mcpServers` MAP. Only emits keys the given CLI
 * understands so we never write an entry it would reject:
 *   stdio  → { command, args?, env? }        (both CLIs)
 *   remote → { type, url, headers? }          (Claude --mcp-config AND Kiro
 *            agent config both key the transport as `type`; Kiro's mcp.json
 *            also accepts `transport`, but we write an agent config, not mcp.json)
 * Reserved names are dropped. Assumes input passed validateMcpServers.
 */
function toMcpServerMap(servers) {
  const map = {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) return map;
  for (const [name, server] of Object.entries(servers)) {
    if (!server || typeof server !== 'object') continue;
    if (RESERVED_SERVER_NAMES.has(name)) continue;
    const type = server.type ?? 'stdio';
    if (type === 'stdio') {
      const entry = { command: server.command };
      if (Array.isArray(server.args)) entry.args = server.args;
      if (server.env && typeof server.env === 'object') entry.env = server.env;
      map[name] = entry;
    } else {
      const entry = { type, url: server.url };
      if (server.headers && typeof server.headers === 'object') entry.headers = server.headers;
      map[name] = entry;
    }
  }
  return map;
}

/**
 * Merge two raw JSON-string OBJECTS of custom MCP servers (global + project),
 * both keyed by name. A project entry overrides the global one of the same name
 * (project is more specific). Returns a keyed OBJECT. Best-effort: unparseable
 * inputs are treated as empty.
 */
function mergeMcpServers(globalJson, projectJson) {
  const parse = (raw) => {
    if (!raw) return {};
    try {
      const v = JSON.parse(raw);
      return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
    } catch {
      return {};
    }
  };
  return { ...parse(globalJson), ...parse(projectJson) };
}

export {
  RESERVED_SERVER_NAME,
  RESERVED_SERVER_NAMES,
  KNOWN_AGENT_IMAGE_MCP_COMMANDS,
  MAX_SERVERS,
  validateMcpServers,
  validateMcpServersJson,
  toMcpServerMap,
  mergeMcpServers,
};
export default {
  RESERVED_SERVER_NAME,
  RESERVED_SERVER_NAMES,
  KNOWN_AGENT_IMAGE_MCP_COMMANDS,
  MAX_SERVERS,
  validateMcpServers,
  validateMcpServersJson,
  toMcpServerMap,
  mergeMcpServers,
};
