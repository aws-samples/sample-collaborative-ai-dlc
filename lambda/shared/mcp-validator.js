'use strict';

// Validates a MCP server config against the ACP
// `session/new` schema (https://agentclientprotocol.com/protocol/session-setup#mcp-servers).
//
// This is the wire format the agent CLI receives when starting a session — NOT
// the per-CLI config-file format (which differs between Kiro / Claude / OpenCode).
// Users typically paste from one of those config files; the validator catches
// the mismatch with field-targeted error messages.
//
// Strict mode: unknown keys are rejected so users learn the right format
// instead of silently losing fields.

const ALLOWED_TYPES = new Set(['stdio', 'http', 'sse']);
const STDIO_ALLOWED_KEYS = new Set(['type', 'name', 'command', 'args', 'env']);
const HTTP_ALLOWED_KEYS = new Set(['type', 'name', 'url', 'headers']);
const NAME_VALUE_KEYS = new Set(['name', 'value']);

// Validate a single {name, value} pair (used for env entries and HTTP headers).
function validateNameValuePair(item, path, issues, kind) {
  if (item === null || typeof item !== 'object' || Array.isArray(item)) {
    issues.push({
      path,
      message: `Expected ${kind} entry to be an object {name, value}; got ${describe(item)}.`,
    });
    return;
  }
  for (const key of Object.keys(item)) {
    if (!NAME_VALUE_KEYS.has(key)) {
      issues.push({
        path: `${path}.${key}`,
        message: `Unknown key "${key}". Allowed: name, value.`,
      });
    }
  }
  if (typeof item.name !== 'string' || item.name.length === 0) {
    issues.push({ path: `${path}.name`, message: 'Required non-empty string.' });
  }
  if (typeof item.value !== 'string') {
    issues.push({ path: `${path}.value`, message: 'Required string.' });
  }
}

function describe(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
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
      message: 'Required non-empty string (path to the MCP server executable).',
    });
  }
  if (!Array.isArray(server.args)) {
    issues.push({
      path: `${path}.args`,
      message: `Required array of strings (use [] if no arguments); got ${describe(server.args)}.`,
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
  if (server.env !== undefined) {
    if (!Array.isArray(server.env)) {
      issues.push({
        path: `${path}.env`,
        message: `Expected array of {name, value} entries; got ${describe(server.env)}.`,
      });
    } else {
      server.env.forEach((entry, i) =>
        validateNameValuePair(entry, `${path}.env[${i}]`, issues, 'env'),
      );
    }
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
    try {
      // eslint-disable-next-line no-new
      new URL(server.url);
    } catch {
      issues.push({ path: `${path}.url`, message: `Invalid URL: "${server.url}".` });
    }
  }
  if (!Array.isArray(server.headers)) {
    issues.push({
      path: `${path}.headers`,
      message: `Required array of {name, value} entries; got ${describe(server.headers)}.`,
    });
  } else {
    server.headers.forEach((entry, i) =>
      validateNameValuePair(entry, `${path}.headers[${i}]`, issues, 'header'),
    );
  }
}

function validateServer(server, path, issues) {
  if (server === null || typeof server !== 'object' || Array.isArray(server)) {
    issues.push({ path, message: `Expected an object; got ${describe(server)}.` });
    return;
  }
  if (typeof server.name !== 'string' || server.name.length === 0) {
    issues.push({ path: `${path}.name`, message: 'Required non-empty string.' });
  }
  // Determine transport. Default: stdio. Reject unknown values.
  let type = server.type;
  if (type === undefined) {
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
 * Validate a parsed MCP servers value (already-parsed JSON, expected to be an
 * array of MCP server objects). Returns `{ valid, issues }`.
 *
 * Issues have the shape `{ path, message }` where `path` is a JSON-ish locator
 * like `[0].headers[1].value` so the UI can point at the exact field.
 */
function validateMcpServers(value) {
  const issues = [];
  if (!Array.isArray(value)) {
    issues.push({
      path: '',
      message: `Expected a JSON array of MCP servers; got ${describe(value)}.`,
    });
    return { valid: false, issues };
  }
  const seenNames = new Set();
  value.forEach((server, i) => {
    const path = `[${i}]`;
    validateServer(server, path, issues);
    if (server && typeof server === 'object' && typeof server.name === 'string') {
      if (seenNames.has(server.name)) {
        issues.push({ path: `${path}.name`, message: `Duplicate server name "${server.name}".` });
      }
      seenNames.add(server.name);
    }
  });
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

module.exports = {
  validateMcpServers,
  validateMcpServersJson,
};
