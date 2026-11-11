// runtime_mcp_credentials = gateway_only makes the runtime-provided MCP
// configuration the ONLY one an agent CLI loads. Each CLI also discovers MCP
// servers on its own — from the repository it works in and from the user's
// home — which would let a repository-defined server connect directly from the
// microVM, credentials included, without the platform settings or the Gateway.
// Per CLI (fresh, resumed and one-shot runs alike):
//   Claude Code — `--strict-mcp-config` (cli/drivers.js): only `--mcp-config`
//                 servers load; project `.mcp.json`, user and plugin servers
//                 are ignored. Without `--mcp-config` no server loads.
//   Kiro        — the runtime's agent sets `includeMcpJson: false`, so the
//                 global and workspace `.kiro/settings/mcp.json` stay out; a
//                 one-shot without an agent gets an MCP-free one.
//   Codex       — CODEX_HOME is already private; the workspace and its
//                 ancestors are marked untrusted there, which makes Codex skip
//                 every project `.codex/` layer (config, hooks, rules). A
//                 one-shot without a home gets a private MCP-free one.
//   OpenCode    — has no switch for project MCP alone
//                 (OPENCODE_DISABLE_PROJECT_CONFIG also drops the repository's
//                 AGENTS.md and the runtime's relative instructions), and it
//                 deep-merges every config layer. So every server another
//                 layer defines is listed again in the inline config, which
//                 OpenCode reads last, with `enabled: false`. OPENCODE_PURE
//                 (cli/drivers.js) keeps workspace and user plugins, whose
//                 `config` hook could re-enable them, from loading.
// This isolates the agent's MCP tools only. Code the agent runs (shell, curl)
// is bounded by network egress control, not by this module.
// Allow mode never calls into this module.
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parse as parseJsonc, visit as visitJsonc } from 'jsonc-parser';
import { RuntimeMcpPolicyError } from '../../shared/runtime-mcp-policy.js';

const missing = (error) => error?.code === 'ENOENT' || error?.code === 'ENOTDIR';

const exists = async (file) => {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
};

// The working directory and each ancestor up to the nearest repository root
// (inclusive), or up to the filesystem root outside a repository: the
// directories OpenCode and Codex walk for project configuration. Both the
// given and the symlink-resolved spelling are returned.
export const projectDirectories = async (cwd) => {
  if (typeof cwd !== 'string' || !cwd) {
    throw new TypeError('MCP isolation needs the working directory the CLI runs in');
  }
  const directories = [];
  let current = path.resolve(cwd);
  for (;;) {
    directories.push(current);
    if (await exists(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  const resolved = await Promise.all(
    directories.map((directory) =>
      realpath(directory).catch((error) => {
        if (missing(error)) return directory;
        throw error;
      }),
    ),
  );
  return [...new Set([...directories, ...resolved])];
};

const unreadable = (file, reason) =>
  new RuntimeMcpPolicyError(
    `${file} ${reason}; this deployment serves custom MCP servers only through ` +
      'the AgentCore Gateway (runtime_mcp_credentials = "gateway_only"), so a configuration ' +
      'whose MCP servers cannot be read is not run.',
  );

// OpenCode replaces `{env:NAME}` (raw) and then `{file:path}` (JSON-escaped)
// in the config TEXT before parsing it (config/variable.ts), so a token outside
// a string value — in a key, a comment, or spanning strings — changes the
// structure OpenCode parses. Tokens are accepted only fully inside one string
// value. A value with an `{env:…}` token may hold no other `{`: replacing the
// token could otherwise join text into a `{file:…}` token that ends beyond the
// string.
// The names and fields read here are copied, decoded, into the inline config,
// where OpenCode substitutes them again. So a string (key or value) whose
// decoded text has a token, or the start of one, that its written text does
// not — `"\u007benv:X}"` — is refused: the inline copy would no longer name or
// match the entry it disables.
const SUBSTITUTION_TOKENS = [/\{env:[^}]+\}/g, /\{file:[^}]+\}/g];
const TOKEN_STARTS = /\{(?:env|file):[^}]*\}?/g;

const tokenStarts = (text) => [...text.matchAll(TOKEN_STARTS)].map(([token]) => token).join('\0');

const substitutesOutsideValues = (text) => {
  const values = [];
  const decoded = [];
  const literal = (value, offset, length) => {
    decoded.push([value, text.slice(offset + 1, offset + length - 1)]);
  };
  visitJsonc(
    text,
    {
      onObjectProperty: literal,
      onLiteralValue: (value, offset, length) => {
        if (typeof value !== 'string') return;
        values.push([offset + 1, offset + length - 1]);
        literal(value, offset, length);
      },
    },
    { allowTrailingComma: true },
  );
  const tokens = SUBSTITUTION_TOKENS.flatMap((pattern) => [...text.matchAll(pattern)]);
  const outside = tokens.some(
    ({ index, 0: token }) =>
      !values.some(([start, end]) => start <= index && index + token.length <= end),
  );
  return (
    outside ||
    values.some(([start, end]) => {
      const value = text.slice(start, end);
      return /\{env:[^}]+\}/.test(value) && value.replace(/\{env:[^}]+\}/g, '').includes('{');
    }) ||
    decoded.some(([value, written]) => tokenStarts(value) !== tokenStarts(written))
  );
};

// Parsed exactly as OpenCode parses it (jsonc-parser, trailing commas allowed,
// any error fatal), so the server names read here are the names OpenCode reads.
// OpenCode decodes the file with a BOM-stripping decoder; Node's does not.
export const parseOpenCodeConfig = (text, file) => {
  const errors = [];
  const source = text.replace(/^\uFEFF/, '');
  const data = parseJsonc(source, errors, { allowTrailingComma: true });
  if (errors.length) throw unreadable(file, 'is not valid JSONC');
  if (substitutesOutsideValues(source)) {
    throw unreadable(file, 'substitutes {env:…} or {file:…} outside a string value');
  }
  return data;
};

// A configuration file that exists but cannot be read is refused: its servers
// could not be neutralized.
const readJsoncFile = async (file) => {
  let text;
  try {
    text = await readFile(file, 'utf8');
  } catch (error) {
    if (missing(error) || error?.code === 'EISDIR') return null;
    throw error;
  }
  return parseOpenCodeConfig(text, file);
};

const isRecord = (value) => Boolean(value) && typeof value === 'object' && !Array.isArray(value);

// The server names OpenCode derives from one file's `mcp` object: its entries,
// and the entries of an `mcp.servers` envelope (OpenCode's V2 form, flattened
// into `mcp` when `servers` is not itself a server).
const openCodeServers = (mcp) => {
  if (!isRecord(mcp)) return [];
  const { servers } = mcp;
  const envelope =
    isRecord(servers) &&
    !['type', 'enabled'].some(
      (key) =>
        Object.hasOwn(servers, key) &&
        (servers[key] === null || typeof servers[key] !== 'object' || Array.isArray(servers[key])),
    );
  return [
    ...Object.entries(mcp).filter(([name]) => !(envelope && name === 'servers')),
    ...(envelope ? Object.entries(servers) : []),
  ];
};

const OPENCODE_FILES = ['opencode.jsonc', 'opencode.json'];
// Global config also accepts the legacy config.json.
const OPENCODE_GLOBAL_FILES = ['config.json', ...OPENCODE_FILES];

// Every config file OpenCode merges for a run in `cwd`, except the managed
// (root-owned, image-controlled) ones: the global directory, `~/.opencode`, and
// per project directory its `opencode.json(c)` and `.opencode/opencode.json(c)`.
// The child environment (cli/environment.js) carries no XDG_CONFIG_HOME,
// OPENCODE_CONFIG or OPENCODE_CONFIG_DIR, so those locations are fixed.
export const openCodeConfigFiles = async ({ cwd, home = os.homedir() }) => {
  const globalDir = path.join(home, '.config', 'opencode');
  const files = [
    ...OPENCODE_GLOBAL_FILES.map((name) => path.join(globalDir, name)),
    ...OPENCODE_FILES.map((name) => path.join(home, '.opencode', name)),
  ];
  for (const directory of await projectDirectories(cwd)) {
    files.push(
      ...OPENCODE_FILES.map((name) => path.join(directory, name)),
      ...OPENCODE_FILES.map((name) => path.join(directory, '.opencode', name)),
    );
  }
  return [...new Set(files)];
};

// The disabled stand-in for a server another layer defines. It keeps the
// entry's transport fields so it is a valid entry on its own and merges into
// the original without changing its type; credentials are not copied.
const disabledOpenCodeServer = (server) => {
  const fields =
    server && typeof server === 'object' && !Array.isArray(server)
      ? Object.fromEntries(
          ['type', 'command', 'url']
            .filter((key) => server[key] !== undefined)
            .map((key) => [key, server[key]]),
        )
      : {};
  return { ...fields, enabled: false };
};

// `config` is the runtime's inline OpenCode config (object). Returns it with
// every server another layer defines disabled; the runtime's own entries keep
// their position after them, so they still win a name collision.
export const exclusiveOpenCodeConfig = async ({ config = {}, cwd, home }) => {
  const own = config.mcp ?? {};
  const foreign = {};
  for (const file of await openCodeConfigFiles({ cwd, home })) {
    const parsed = await readJsoncFile(file);
    for (const [name, server] of openCodeServers(parsed?.mcp)) {
      if (!Object.hasOwn(own, name)) foreign[name] = disabledOpenCodeServer(server);
    }
  }
  return { ...config, mcp: { ...foreign, ...own } };
};

// Codex: mark the workspace and its ancestors untrusted in the private
// CODEX_HOME so no project `.codex/config.toml` (and its MCP servers) loads.
export const codexUntrustedProjectsToml = async (cwd) =>
  (await projectDirectories(cwd))
    .map((directory) => `[projects.${JSON.stringify(directory)}]\ntrust_level = "untrusted"`)
    .join('\n\n');
