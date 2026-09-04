// verify-mcp — probe custom MCP servers INSIDE the AgentCore container so the
// project-settings UI can confirm a config actually works before it's saved:
// same image (uvx/npx/python3 on PATH), same network egress, same env the real
// agent gets. Runs as a stateless /invocations command (like `capabilities`) —
// no workspace/repo/microVM-session machinery.
//
// The handshake is delegated to the official @modelcontextprotocol/sdk Client +
// its transports (Stdio / StreamableHTTP / SSE) so we get spec-correct behavior
// for free: initialize → notifications/initialized, protocol negotiation, and
// the Mcp-Session-Id echo that stateful Streamable-HTTP servers require. A
// hand-rolled JSON-RPC flow gets those wrong and false-fails compliant servers.
//
// Pure of ambient I/O: `probeServer` is injected so it unit-tests without a real
// process/network; the default implementation uses the SDK.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import mcpValidatorPkg from '../../shared/mcp-validator.js';
import {
  computeSurvivors,
  resolveMcpSecrets as defaultResolveMcpSecrets,
  RESERVED_MCP_ENV_KEYS,
} from '../mcp-secret-resolver.js';
import { mcpSecretPaths } from '../mcp-secret-paths.js';

const { validateMcpServers, toMcpServerMap, extractSecretRefs } = mcpValidatorPkg;

const DEFAULT_TIMEOUT_MS = 25_000;
const CLIENT_INFO = { name: 'aidlc-verify', version: '1.0.0' };

// Global (non-anchored) `${VAR}` matcher — expand a resolved value into a string.
const REF_TOKEN = /\$\{([A-Za-z_][A-Za-z0-9_]{0,127})\}/g;
const expandRefs = (str, secretEnv) =>
  typeof str === 'string'
    ? str.replace(REF_TOKEN, (whole, name) =>
        Object.prototype.hasOwnProperty.call(secretEnv, name) ? secretEnv[name] : whole,
      )
    : str;

// Expand `${VAR}` refs in a (transformed) server spec's env/headers values using
// the resolved secretEnv — refs are only allowed there (url is rejected at
// validation). Returns a NEW spec; the input is not mutated.
const expandServerSecrets = (server, secretEnv) => {
  const out = { ...server };
  if (out.env && typeof out.env === 'object') {
    out.env = Object.fromEntries(
      Object.entries(out.env).map(([k, v]) => [k, expandRefs(v, secretEnv)]),
    );
  }
  if (out.headers && typeof out.headers === 'object') {
    out.headers = Object.fromEntries(
      Object.entries(out.headers).map(([k, v]) => [k, expandRefs(v, secretEnv)]),
    );
  }
  return out;
};

// Build the SDK transport for a (transformed) server spec.
//   stdio  → StdioClientTransport (spawns command+args; env merged over the
//            SDK's safe default so uvx/npx/etc. on the image PATH resolve)
//   http   → StreamableHTTPClientTransport (handles session id + init notif)
//   sse    → SSEClientTransport
const makeTransport = (server) => {
  if (typeof server.url === 'string') {
    const url = new URL(server.url);
    const requestInit = server.headers ? { headers: server.headers } : undefined;
    return server.type === 'sse'
      ? new SSEClientTransport(url, requestInit ? { requestInit } : undefined)
      : new StreamableHTTPClientTransport(url, requestInit ? { requestInit } : undefined);
  }
  return new StdioClientTransport({
    command: server.command,
    args: server.args ?? [],
    env: { ...getDefaultEnvironment(), ...server.env },
  });
};

// Default probe: connect (runs the full MCP handshake), list tools, close.
// Resolves { ok:true, tools } | { ok:false, error }. Never throws.
const defaultProbeServer = async (server, { timeoutMs }) => {
  const client = new Client(CLIENT_INFO, { capabilities: {} });
  let transport;
  try {
    transport = makeTransport(server);
  } catch (e) {
    return { ok: false, error: `bad server config: ${e?.message ?? e}` };
  }
  // Hard wall-clock guard around connect+list (a hung server / slow first-run
  // uvx download must not wedge the probe).
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`timed out after ${timeoutMs}ms`)), timeoutMs),
  );
  try {
    await Promise.race([client.connect(transport, { timeout: timeoutMs }), timeout]);
    const { tools } = await Promise.race([client.listTools(), timeout]);
    return { ok: true, tools: (tools ?? []).map((t) => t.name).filter(Boolean) };
  } catch (e) {
    return { ok: false, error: e?.message ?? String(e) };
  } finally {
    try {
      await client.close();
    } catch {
      /* transport may already be down */
    }
  }
};

/**
 * Verify a set of custom MCP servers. Payload:
 *   {
 *     mcpServers: { "<name>": {...} },       // legacy: single tier (treated as project when projectId set, else global)
 *     mcpServersByTier: { global, project }, // preferred: the two tiers to verify
 *     projectId?: string,                    // present → project verify
 *     unsavedSecrets?: { VAR: value },       // just-typed, tier-scoped to the caller
 *   }
 * Returns { results: { "<name>": { ok, tools?, error? } } }, or { error, issues }
 * when a tier's config fails validation (caller maps to 400).
 *
 * Secret `${VAR}` refs are resolved (survivors-first, tier-bound, fail-closed per
 * server) and expanded into the probed spec's env/headers just before makeTransport
 * — the same values the real agent would get. A ref with no value in either source
 * yields a per-server "secret not set" result WITHOUT blocking the other servers.
 */
export const verifyMcp = async (payload, deps = {}) => {
  const {
    probeServer = defaultProbeServer,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    resolveMcpSecrets = defaultResolveMcpSecrets,
  } = deps;

  const projectId = payload?.projectId || null;
  // Normalize input into the two-tier shape. Legacy single-map payloads (older
  // frontends) map to the caller's own tier; the other tier is empty.
  const byTier = payload?.mcpServersByTier ?? {
    global: projectId ? {} : (payload?.mcpServers ?? {}),
    project: projectId ? (payload?.mcpServers ?? {}) : {},
  };
  const global = byTier.global ?? {};
  const project = byTier.project ?? {};

  // Validate each tier's config; surface the first failing tier's issues.
  for (const tier of [global, project]) {
    const validation = validateMcpServers(tier ?? {});
    if (!validation.valid) {
      return { error: 'Invalid MCP servers configuration', issues: validation.issues };
    }
  }

  // 1. Survivors (project overrides global by name).
  const { survivingGlobal, survivingProject } = computeSurvivors(global, project);

  // Cross-tier flat-env collision set: `${VAR}` names referenced by BOTH a
  // surviving global server AND a surviving project server. The child env is one
  // flat namespace, so such a name cannot carry two tier values — the runtime
  // fails the stage closed; verify must fail those servers closed too (never
  // silently probe both with one value). Computed independently of resolution.
  const globalRefSet = extractSecretRefs(survivingGlobal).refs;
  const projectRefSet = extractSecretRefs(survivingProject).refs;
  const collidingRefs = new Set([...globalRefSet].filter((v) => projectRefSet.has(v)));

  // 2/3/4. Resolve refs, tier-bound, with tier-scoped just-typed overrides.
  //   - a PROJECT verify may override only project refs;
  //   - a GLOBAL verify may override only global refs.
  // A collision or an unset ref does NOT abort the whole verify — we resolve
  // best-effort and mark the individual servers whose refs are unmet/colliding.
  const { globalPath, projectPath } = mcpSecretPaths({ projectId });
  const unsaved = payload?.unsavedSecrets ?? {};
  const overrides = projectId ? { project: unsaved } : { global: unsaved };

  let secretEnv = {};
  try {
    ({ secretEnv } = await resolveMcpSecrets({
      survivingGlobal,
      survivingProject,
      globalPath,
      projectPath,
      overrides,
    }));
  } catch {
    // A collision, reserved-name, or unresolved ref threw. Fall back to per-server
    // reporting: resolve whatever we can (best-effort, no throw) so servers WITHOUT
    // an offending ref still probe. Collisions/reserved/missing are reported per
    // server below — never masked by the merge.
    secretEnv = await resolveBestEffort({
      survivingGlobal,
      survivingProject,
      globalPath,
      projectPath,
      overrides,
      resolveMcpSecrets,
    });
  }

  // Build the merged survivor map (same as the runtime) and probe each entry.
  const survivorMap = {
    ...toMcpServerMap(survivingGlobal),
    ...toMcpServerMap(survivingProject),
  };
  // Per-server ref map so we can report the FIRST offending ref precisely.
  const refsByServer = serverRefMap(survivingGlobal, survivingProject);

  const names = Object.keys(survivorMap);
  const entries = await Promise.all(
    names.map(async (name) => {
      const refs = refsByServer[name] ?? [];
      // Reserved-name guard (same hard boundary the resolver enforces): a ref may
      // not shadow a runtime env key (auth / AWS creds / cache). Report it as a
      // distinct, actionable per-server error rather than a generic "not set".
      const reservedRef = refs.find((v) => RESERVED_MCP_ENV_KEYS.has(v));
      if (reservedRef) {
        return [
          name,
          {
            ok: false,
            error: `references \`\${${reservedRef}}\`, a reserved runtime variable name that can't be used — rename it to something server-specific`,
          },
        ];
      }
      // Cross-tier collision guard: report closed (do NOT probe) — the resolved
      // value would be ambiguous across tiers. Distinct from a missing ref.
      const collidingRef = refs.find((v) => collidingRefs.has(v));
      if (collidingRef) {
        return [
          name,
          {
            ok: false,
            error: `references \`\${${collidingRef}}\` which is also used by a server in the other tier — the same variable name can't carry two tier values; rename one or override that server by name`,
          },
        ];
      }
      const unmet = refs.find((v) => !Object.prototype.hasOwnProperty.call(secretEnv, v));
      if (unmet) {
        return [
          name,
          {
            ok: false,
            error: `references secret "${unmet}" which is not set — enter it in the field above (or Save it), then Test`,
          },
        ];
      }
      const expanded = expandServerSecrets(survivorMap[name], secretEnv);
      return [name, await probeServer(expanded, { timeoutMs })];
    }),
  );

  return { results: Object.fromEntries(entries) };
};

// Map each surviving server name → the list of `${VAR}` names it references
// (env/headers only). Used to report the precise unmet ref per server.
const serverRefMap = (survivingGlobal, survivingProject) => {
  const map = {};
  for (const tier of [survivingGlobal, survivingProject]) {
    for (const [name, server] of Object.entries(tier ?? {})) {
      const { refs } = extractSecretRefs({ [name]: server });
      map[name] = [...refs];
    }
  }
  return map;
};

// Resolve each tier's refs one-by-one, tolerating misses (unresolved refs are
// simply absent from the returned map — the caller reports them per server).
const resolveBestEffort = async ({
  survivingGlobal,
  survivingProject,
  globalPath,
  projectPath,
  overrides,
  resolveMcpSecrets,
}) => {
  const out = {};
  const each = async (tierKey, tierMap) => {
    for (const [name, server] of Object.entries(tierMap ?? {})) {
      try {
        const { secretEnv } = await resolveMcpSecrets({
          survivingGlobal: tierKey === 'global' ? { [name]: server } : {},
          survivingProject: tierKey === 'project' ? { [name]: server } : {},
          globalPath,
          projectPath,
          overrides:
            tierKey === 'global' ? { global: overrides.global } : { project: overrides.project },
        });
        Object.assign(out, secretEnv);
      } catch {
        // leave this server's refs unresolved → reported per server
      }
    }
  };
  await each('global', survivingGlobal);
  await each('project', survivingProject);
  return out;
};
