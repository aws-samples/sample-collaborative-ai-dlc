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
//                 OpenCode reads last, with `enabled: false`.
// This isolates the agent's MCP tools only. Code the agent runs (shell, curl)
// is bounded by network egress control, not by this module.
// Allow mode never calls into this module.
import { readFile, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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

// JSONC → JSON: drop comments and trailing commas outside strings.
export const stripJsonc = (text) => {
  let out = '';
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (char === '"') {
      let end = index + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      out += text.slice(index, end + 1);
      index = end + 1;
    } else if (char === '/' && text[index + 1] === '/') {
      while (index < text.length && text[index] !== '\n') index += 1;
    } else if (char === '/' && text[index + 1] === '*') {
      const end = text.indexOf('*/', index + 2);
      index = end === -1 ? text.length : end + 2;
    } else {
      out += char;
      index += 1;
    }
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
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
  try {
    return JSON.parse(stripJsonc(text));
  } catch {
    throw new RuntimeMcpPolicyError(
      `${file} is not valid JSON; this deployment serves custom MCP servers only through ` +
        'the AgentCore Gateway (runtime_mcp_credentials = "gateway_only"), so a configuration ' +
        'whose MCP servers cannot be read is not run.',
    );
  }
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
    const servers = parsed?.mcp;
    if (!servers || typeof servers !== 'object' || Array.isArray(servers)) continue;
    for (const [name, server] of Object.entries(servers)) {
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
