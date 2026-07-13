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

describe('verifyMcp — validation', () => {
  it('rejects an invalid config with issues (no probing)', async () => {
    const probe = recordingProbe();
    const res = await verifyMcp({ mcpServers: { x: {} } }, { probeServer: probe }); // missing command
    expect(res.error).toMatch(/Invalid MCP/);
    expect(Array.isArray(res.issues)).toBe(true);
    expect(res.results).toBeUndefined();
    expect(probe.seen).toHaveLength(0);
  });

  it('rejects a reserved name (whole config invalid, nothing probed)', async () => {
    const probe = recordingProbe();
    const res = await verifyMcp(
      { mcpServers: { aidlc: { command: 'node' }, ok: { command: 'uvx' } } },
      { probeServer: probe },
    );
    expect(res.error).toMatch(/Invalid MCP/);
    expect(probe.seen).toHaveLength(0);
  });

  it('accepts an empty config', async () => {
    const res = await verifyMcp({ mcpServers: {} }, { probeServer: recordingProbe() });
    expect(res.results).toEqual({});
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
        mcpServers: {
          fetch: { command: 'uvx', args: ['mcp-server-fetch'] },
          remote: { type: 'http', url: 'https://e.com/mcp' },
        },
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
      { mcpServers: { s: { command: 'uvx', args: ['x'], env: { K: 'v' } } } },
      { probeServer: probe },
    );
    expect(probe.seen[0]).toEqual({ command: 'uvx', args: ['x'], env: { K: 'v' } });
  });

  it('hands the transformed remote spec (type/url/headers) to the probe', async () => {
    const probe = recordingProbe();
    await verifyMcp(
      { mcpServers: { r: { type: 'sse', url: 'https://e.com/sse', headers: { A: '1' } } } },
      { probeServer: probe },
    );
    expect(probe.seen[0]).toEqual({ type: 'sse', url: 'https://e.com/sse', headers: { A: '1' } });
  });

  it('passes a probe failure straight through as ok:false', async () => {
    const probe = async () => ({ ok: false, error: 'timed out after 25000ms' });
    const res = await verifyMcp({ mcpServers: { x: { command: 'uvx' } } }, { probeServer: probe });
    expect(res.results.x).toEqual({ ok: false, error: 'timed out after 25000ms' });
  });
});
