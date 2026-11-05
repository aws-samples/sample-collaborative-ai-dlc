import { describe, expect, it } from 'vitest';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  buildMcpConfig,
  gatewayToolsLaunch,
  materializeCodexHome,
  materializeKiroAgent,
  materializeMcpConfig,
  materializeOpenCodeConfig,
} from '../stage-materializer.js';
import { withCredentialSession } from '../credential-session.js';
import { runWithGatewayGrant } from '../mcp/gateway-context.js';
import { GATEWAY_TOOLS_SERVER_NAME } from '../cli/drivers.js';

const scope = {
  projectId: 'p-1',
  intentId: 'i-1',
  executionId: 'e-1',
  stageId: 'requirements-analysis',
  stageInstanceId: 'si-1',
  role: 'author',
  mode: 'stage',
};
const GATEWAY_ENV = {
  AIDLC_MCP_GATEWAY_URL: 'https://gw.example/mcp',
  AIDLC_MCP_GATEWAY_CUSTOM_TARGETS: 'true',
  AWS_REGION: 'eu-central-1',
};
const SENTINEL = 'sentinel-customer-secret-7f3a';
const customServers = { [GATEWAY_TOOLS_SERVER_NAME]: { command: 'evil', env: { K: SENTINEL } } };

const inSession = (operation) =>
  withCredentialSession(() => runWithGatewayGrant('grant-token', operation));

const relaySocket = (entry) => {
  expect(entry.command).toBe(process.execPath);
  expect(entry.args[0]).toMatch(/mcp\/stdio-relay\.js$/);
  return entry.args[1];
};

describe('customer-tool proxy launch', () => {
  const launch = {
    entry: '/srv/gateway-proxy.js',
    trustedEnv: { AIDLC_MCP_GATEWAY_GRANT: 'g', V2_MCP_ROLE: 'author' },
  };

  it('runs the passthrough proxy with the same grant for a stage session', () => {
    const tools = gatewayToolsLaunch({ launch, env: GATEWAY_ENV, scope });
    expect(tools.entry).toMatch(/mcp\/gateway-proxy\.js$/);
    expect(tools.trustedEnv).toEqual({
      ...launch.trustedEnv,
      AIDLC_MCP_GATEWAY_MODE: 'passthrough',
    });
  });

  it('also serves dispatched persona sessions, whose scope names no mode', () => {
    const { mode: _mode, ...personaScope } = scope;
    expect(
      gatewayToolsLaunch({
        launch,
        env: GATEWAY_ENV,
        scope: { ...personaScope, role: 'reviewer', reviewerAgent: 'security-reviewer' },
      }),
    ).not.toBeNull();
  });

  it.each([
    ['no customer targets', { ...GATEWAY_ENV, AIDLC_MCP_GATEWAY_CUSTOM_TARGETS: undefined }, scope],
    ['no Gateway', { AIDLC_MCP_GATEWAY_CUSTOM_TARGETS: 'true' }, scope],
    ['a discussion session', GATEWAY_ENV, { ...scope, mode: 'discussion' }],
    ['a conflict session', GATEWAY_ENV, { ...scope, mode: 'conflict' }],
  ])('is not started with %s', (_label, env, s) => {
    expect(gatewayToolsLaunch({ launch, env, scope: s })).toBeNull();
  });

  it('keeps the config unchanged when no customer-tool socket exists', () => {
    expect(
      Object.keys(buildMcpConfig({ mcpEntry: '/srv/mcp.js', scope, env: {} }).mcpServers),
    ).toEqual(['aidlc']);
  });
});

describe('customer-tool entry for every CLI', () => {
  it('claude: one reserved relay entry on its own socket, winning a name collision', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-gw-claude-'));
    await inSession(async () => {
      const configPath = await materializeMcpConfig({
        workspaceDir: ws,
        mcpEntry: '/srv/mcp.js',
        scope,
        env: GATEWAY_ENV,
        customServers,
      });
      const { mcpServers } = JSON.parse(await readFile(configPath, 'utf8'));
      expect(Object.keys(mcpServers)).toEqual([GATEWAY_TOOLS_SERVER_NAME, 'aidlc']);
      expect(relaySocket(mcpServers[GATEWAY_TOOLS_SERVER_NAME])).not.toBe(
        relaySocket(mcpServers.aidlc),
      );
      expect(JSON.stringify(mcpServers)).not.toContain(SENTINEL);
      expect(JSON.stringify(mcpServers)).not.toContain('grant-token');
      expect(JSON.stringify(mcpServers)).not.toContain('gw.example');
    });
  });

  it('kiro: the agent config carries the relay entry', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-gw-kiro-'));
    await inSession(async () => {
      const agentName = await materializeKiroAgent({
        workspaceDir: ws,
        mcpEntry: '/srv/mcp.js',
        scope,
        env: GATEWAY_ENV,
      });
      const config = JSON.parse(
        await readFile(path.join(ws, '.kiro', 'agents', `${agentName}.json`), 'utf8'),
      );
      relaySocket(config.mcpServers[GATEWAY_TOOLS_SERVER_NAME]);
      expect(JSON.stringify(config)).not.toContain('grant-token');
    });
  });

  it('opencode: a local relay entry, the built-in server still last', async () => {
    await inSession(async () => {
      const config = JSON.parse(
        await materializeOpenCodeConfig({ mcpEntry: '/srv/mcp.js', scope, env: GATEWAY_ENV }),
      );
      expect(Object.keys(config.mcp)).toEqual([GATEWAY_TOOLS_SERVER_NAME, 'aidlc']);
      expect(config.mcp[GATEWAY_TOOLS_SERVER_NAME]).toMatchObject({ type: 'local' });
      expect(config.mcp[GATEWAY_TOOLS_SERVER_NAME].command[1]).toMatch(/stdio-relay\.js$/);
      expect(JSON.stringify(config)).not.toContain('grant-token');
    });
  });

  it('codex: a relay table with timeouts, not required', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'aidlc-gw-codex-'));
    await inSession(async () => {
      const home = await materializeCodexHome({
        mcpEntry: '/srv/mcp.js',
        scope,
        env: { ...GATEWAY_ENV, V2_CODEX_HOME_ROOT: root },
      });
      const toml = await readFile(path.join(home, 'config.toml'), 'utf8');
      const section = toml.slice(
        toml.indexOf(`[mcp_servers."${GATEWAY_TOOLS_SERVER_NAME}"]`),
        toml.indexOf('[mcp_servers."aidlc"]'),
      );
      expect(section).toContain('startup_timeout_sec = 30');
      expect(section).toContain('tool_timeout_sec = 600');
      expect(section).not.toContain('required = true');
      expect(section).toMatch(/stdio-relay\.js/);
      expect(toml).not.toContain('grant-token');
    });
  });

  it('no entry for a discussion session', async () => {
    const ws = await mkdtemp(path.join(tmpdir(), 'aidlc-gw-discussion-'));
    await inSession(async () => {
      const configPath = await materializeMcpConfig({
        workspaceDir: ws,
        mcpEntry: '/srv/mcp.js',
        scope: { ...scope, mode: 'discussion' },
        env: GATEWAY_ENV,
      });
      const { mcpServers } = JSON.parse(await readFile(configPath, 'utf8'));
      expect(Object.keys(mcpServers)).toEqual(['aidlc']);
    });
  });
});
