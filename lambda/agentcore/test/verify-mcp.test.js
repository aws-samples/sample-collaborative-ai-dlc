import { describe, it, expect } from 'vitest';
import { verifyMcp } from '../commands/verify-mcp.js';

// The MCP handshake itself is delegated to the official SDK (real transports),
// so unit tests inject `probeServer` and assert verifyMcp's own logic: config
// validation, the transform (reserved-name drop, stdio vs remote), parallel
// probing, and per-server result passthrough. A `recording` probe captures the
// (transformed) server specs it was handed.
const recordingProbe = (byName = {}) => {
  const seen = [];
  const fn = async (server) => {
    seen.push(server);
    // Match by a distinguishing field so a test can script per-server results.
    const key = server.command ?? server.url;
    return byName[key] ?? { ok: true, tools: [] };
  };
  fn.seen = seen;
  return fn;
};

// Reuse the REAL resolver with an injected getParam so tier scoping is exercised
// end-to-end. verifyMcp passes globalPath/projectPath it built from mcpSecretPaths.
import { resolveMcpSecrets as realResolve } from '../mcp-secret-resolver.js';
const resolverWithGetter = (store) => (args) =>
  realResolve({ ...args, getParam: async (name) => (name in store ? store[name] : null) });

describe('verifyMcp — validation', () => {
  it('rejects an invalid config with issues (no probing)', async () => {
    const probe = recordingProbe();
    const res = await verifyMcp(
      { mcpServersByTier: { global: { x: {} }, project: {} } },
      { probeServer: probe },
    ); // missing command
    expect(res.error).toMatch(/Invalid MCP/);
    expect(Array.isArray(res.issues)).toBe(true);
    expect(res.results).toBeUndefined();
    expect(probe.seen).toHaveLength(0);
  });

  it('rejects a reserved name (whole config invalid, nothing probed)', async () => {
    const probe = recordingProbe();
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: { aidlc: { command: 'node' }, ok: { command: 'uvx' } },
          project: {},
        },
      },
      { probeServer: probe },
    );
    expect(res.error).toMatch(/Invalid MCP/);
    expect(probe.seen).toHaveLength(0);
  });

  it('accepts an empty config', async () => {
    const res = await verifyMcp(
      { mcpServersByTier: { global: {}, project: {} } },
      { probeServer: recordingProbe() },
    );
    expect(res.results).toEqual({});
  });

  it('accepts a legacy single-map payload (no tier wrapper)', async () => {
    const probe = recordingProbe();
    const res = await verifyMcp({ mcpServers: { s: { command: 'uvx' } } }, { probeServer: probe });
    expect(res.results.s).toEqual({ ok: true, tools: [] });
  });
});

describe('verifyMcp — probing + transform', () => {
  it('probes each server and maps results by name', async () => {
    const probe = recordingProbe({
      uvx: { ok: true, tools: ['fetch', 'fetch_json'] },
      'https://e.com/mcp': { ok: false, error: 'boom' },
    });
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: {},
          project: {
            fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
            remote: { type: 'http', url: 'https://e.com/mcp' },
          },
        },
        projectId: 'proj1',
      },
      { probeServer: probe },
    );
    expect(res.results.fetch).toEqual({ ok: true, tools: ['fetch', 'fetch_json'] });
    expect(res.results.remote).toEqual({ ok: false, error: 'boom' });
    expect(probe.seen).toHaveLength(2);
  });

  it('hands the transformed stdio spec (command/args/env) to the probe', async () => {
    const probe = recordingProbe();
    await verifyMcp(
      {
        mcpServersByTier: {
          global: {},
          project: { s: { command: 'uvx', args: ['x'], env: { K: 'v' } } },
        },
        projectId: 'proj1',
      },
      { probeServer: probe },
    );
    expect(probe.seen[0]).toEqual({ command: 'uvx', args: ['x'], env: { K: 'v' } });
  });

  it('passes a probe failure straight through as ok:false', async () => {
    const probe = async () => ({ ok: false, error: 'timed out after 25000ms' });
    const res = await verifyMcp(
      { mcpServersByTier: { global: { x: { command: 'uvx' } }, project: {} } },
      { probeServer: probe },
    );
    expect(res.results.x).toEqual({ ok: false, error: 'timed out after 25000ms' });
  });
});

describe('verifyMcp — secret resolution', () => {
  it('expands a ${VAR} in env from the SAVED SSM value before probing', async () => {
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: {},
          project: { s: { command: 'uvx', env: { KEY: '${PK}' } } },
        },
        projectId: 'proj1',
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({
          '/p/env/projects/proj1/mcp-secrets/PK': 'resolved-secret',
        }),
      },
    );
    expect(res.results.s).toEqual({ ok: true, tools: [] });
    expect(probe.seen[0]).toEqual({ command: 'uvx', env: { KEY: 'resolved-secret' } });
  });

  it('a project unsavedSecrets entry overrides the saved value for a PROJECT ref', async () => {
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    await verifyMcp(
      {
        mcpServersByTier: {
          global: {},
          project: { s: { command: 'uvx', env: { KEY: '${PK}' } } },
        },
        projectId: 'proj1',
        unsavedSecrets: { PK: 'typed-value' },
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({
          '/p/env/projects/proj1/mcp-secrets/PK': 'saved-value',
        }),
      },
    );
    expect(probe.seen[0]).toEqual({ command: 'uvx', env: { KEY: 'typed-value' } });
  });

  it('a project verify IGNORES an unsavedSecrets entry for a GLOBAL ref (tenant isolation)', async () => {
    // Surviving global server references ${GK}; it must resolve from the SAVED
    // global SSM value, never the project-supplied unsavedSecrets.
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    await verifyMcp(
      {
        mcpServersByTier: {
          global: { g: { command: 'uvx', env: { KEY: '${GK}' } } },
          project: {},
        },
        projectId: 'proj1',
        unsavedSecrets: { GK: 'attacker-typed' },
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({ '/p/env/mcp-secrets/GK': 'saved-global' }),
      },
    );
    expect(probe.seen[0]).toEqual({ command: 'uvx', env: { KEY: 'saved-global' } });
  });

  it('reports a per-server "not set" for an unresolved ref while OTHER servers still probe', async () => {
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: {},
          project: {
            good: { command: 'uvx', env: { KEY: '${OK}' } },
            bad: { command: 'uvx', env: { KEY: '${MISSING}' } },
          },
        },
        projectId: 'proj1',
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({ '/p/env/projects/proj1/mcp-secrets/OK': 'v' }),
      },
    );
    expect(res.results.good).toEqual({ ok: true, tools: [] });
    expect(res.results.bad.ok).toBe(false);
    expect(res.results.bad.error).toMatch(/secret "MISSING" which is not set/);
    // Only the good server was actually probed.
    expect(probe.seen).toHaveLength(1);
  });

  it('reports a per-server reserved-name violation distinctly while OTHER servers still probe', async () => {
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: {},
          project: {
            good: { command: 'uvx', env: { KEY: '${OK}' } },
            evil: { command: 'uvx', env: { LEAK: '${KIRO_API_KEY}' } },
          },
        },
        projectId: 'proj1',
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({ '/p/env/projects/proj1/mcp-secrets/OK': 'v' }),
      },
    );
    expect(res.results.good).toEqual({ ok: true, tools: [] });
    expect(res.results.evil.ok).toBe(false);
    expect(res.results.evil.error).toMatch(/KIRO_API_KEY.*reserved/);
    // Only the good server was actually probed (evil short-circuits, no leak).
    expect(probe.seen).toHaveLength(1);
  });

  it('fails BOTH servers closed on a cross-tier ${VAR} collision (never probes with one value)', async () => {
    // A surviving global server AND a project server both use ${API_KEY} and both
    // values exist. The flat child env can't carry two tier values, so verify must
    // report both closed — NOT resolve one and probe both with it.
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: { gsrv: { command: 'uvx', env: { K: '${API_KEY}' } } },
          project: { psrv: { command: 'uvx', env: { K: '${API_KEY}' } } },
        },
        projectId: 'proj1',
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({
          '/p/env/mcp-secrets/API_KEY': 'global-val',
          '/p/env/projects/proj1/mcp-secrets/API_KEY': 'project-val',
        }),
      },
    );
    expect(res.results.gsrv.ok).toBe(false);
    expect(res.results.gsrv.error).toMatch(/API_KEY.*other tier/);
    expect(res.results.psrv.ok).toBe(false);
    expect(res.results.psrv.error).toMatch(/API_KEY.*other tier/);
    // Neither was probed — no leak of either tier's value.
    expect(probe.seen).toHaveLength(0);
  });

  it('survivors-first: an overridden global ref is neither resolved nor required', async () => {
    // Global `s` uses ${GLOBAL_ONLY} (no saved value). Project overrides `s`.
    // The overridden global does not survive, so its ref never fails the verify.
    process.env.MCP_SECRETS_SSM_PREFIX = '/p/env';
    const probe = recordingProbe();
    const res = await verifyMcp(
      {
        mcpServersByTier: {
          global: { s: { command: 'uvx', env: { KEY: '${GLOBAL_ONLY}' } } },
          project: { s: { command: 'uvx', env: { KEY: '${PK}' } } },
        },
        projectId: 'proj1',
      },
      {
        probeServer: probe,
        resolveMcpSecrets: resolverWithGetter({ '/p/env/projects/proj1/mcp-secrets/PK': 'pv' }),
      },
    );
    expect(res.results.s).toEqual({ ok: true, tools: [] });
    expect(probe.seen[0]).toEqual({ command: 'uvx', env: { KEY: 'pv' } });
  });
});
