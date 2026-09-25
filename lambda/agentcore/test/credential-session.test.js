import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { connect } from 'node:net';
import {
  createCredentialSession,
  runCredentialJob,
  currentCredentialSession,
} from '../credential-session.js';
import { childEnvironment, APPLICATION_CREDENTIAL_ENV } from '../cli/environment.js';
import { captureChild } from '../cli/spawn.js';
import { createRuntimeMcpBridge } from '../mcp/runtime-bridge.js';
import { materializeCliContext } from '../stage-materializer.js';
import { getDriver } from '../cli/drivers.js';
import { createGatewayBackend } from '../cli/backend-adapters.js';
import { resolveStageModel } from '../model-resolver.js';
import { readFile } from 'node:fs/promises';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

afterEach(() => vi.useRealTimers());
describe('credential session lifetime', () => {
  it('retains detached work until its completion and cleans up exactly once', async () => {
    const cleanup = vi.fn();
    const session = createCredentialSession({ env: { KIRO_API_KEY: 'invocation-token' } });
    session.own(cleanup);
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const job = session.run(() =>
      runCredentialJob(async () => {
        await pending;
        expect(currentCredentialSession()).toBe(session);
        expect(session.env.KIRO_API_KEY).toBe('invocation-token');
      }),
    );
    await session.release();
    expect(session.disposed).toBe(false);
    finish();
    await job;
    expect(session.disposed).toBe(true);
    expect(cleanup).toHaveBeenCalledOnce();
    await session.release();
    expect(cleanup).toHaveBeenCalledOnce();
  });
  it('keeps overlapping invocations and cancellation independent', async () => {
    const a = createCredentialSession({ env: { KIRO_API_KEY: 'a' } });
    const b = createCredentialSession({ env: { KIRO_API_KEY: 'b' } });
    a.cancel(new Error('revoked'));
    expect(() => a.env).toThrow('revoked');
    expect(b.run(() => currentCredentialSession().env.KIRO_API_KEY)).toBe('b');
    expect(b.signal.aborted).toBe(false);
    await Promise.all([a.release(), b.release()]);
  });
  it('renews expiring credentials without sliding the provider authorization ceiling', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const refresh = vi.fn(async () => ({ env: { INFERENCE_SESSION: 'renewed' }, expiresAt: 5000 }));
    const session = createCredentialSession({
      env: { INFERENCE_SESSION: 'initial' },
      expiresAt: 3000,
      authorizationExpiresAt: 4000,
      refreshBeforeMs: 1000,
      refresh,
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(session.env.INFERENCE_SESSION).toBe('renewed');
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.signal.aborted).toBe(true);
    expect(() => session.env).toThrow('no longer available');
    await session.release();
  });
  it('cancels after renewal failure and terminates the launched child', async () => {
    const session = createCredentialSession({ env: {} });
    const capture = session.run(() =>
      captureChild({
        command: process.execPath,
        args: ['-e', 'setInterval(() => {}, 1000)'],
        env: {},
      }),
    );
    session.cancel();
    expect((await capture).exitCode).toBeNull();
    await session.release();
  });
  it('enforces expiry while a broker renewal is still outstanding', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1000);
    const session = createCredentialSession({
      expiresAt: 3000,
      refreshBeforeMs: 1000,
      refresh: () => new Promise(() => {}),
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(session.signal.aborted).toBe(true);
    await session.release();
  });
});

describe('credential delivery boundary', () => {
  it('never restores an unknown ambient value or an alternate AWS credential source', () => {
    const ambient = {
      PATH: '/usr/bin',
      HOME: '/home/node',
      SECRET_UNKNOWN: 'unexpected',
      OPENAI_API_KEY: 'ambient-token',
    };
    for (const key of APPLICATION_CREDENTIAL_ENV) ambient[key] = 'runtime-identity';
    const env = childEnvironment(
      { AWS_BEARER_TOKEN_BEDROCK: 'selected', AWS_PROFILE: 'unexpected' },
      ambient,
    );
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('selected');
    expect(env.SECRET_UNKNOWN).toBeUndefined();
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.AWS_PROFILE).toBeUndefined();
    expect(env.AWS_CONFIG_FILE).toBe('/dev/null');
    expect(env.AWS_SHARED_CREDENTIALS_FILE).toBe('/dev/null');
    expect(env.AWS_EC2_METADATA_DISABLED).toBe('true');
  });
  it('inspects the actual spawned environment', async () => {
    const result = await captureChild({
      command: process.execPath,
      args: ['-e', 'console.log(JSON.stringify(process.env))'],
      env: {
        AWS_BEARER_TOKEN_BEDROCK: 'selected-test-key',
        AWS_ACCESS_KEY_ID: 'must-not-reach-cli',
      },
    });
    const env = JSON.parse(result.stdout);
    expect(env.AWS_BEARER_TOKEN_BEDROCK).toBe('selected-test-key');
    expect(env.AWS_ACCESS_KEY_ID).toBeUndefined();
    expect(env.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    expect(env.AWS_WEB_IDENTITY_TOKEN_FILE).toBeUndefined();
  });
  it.each([
    ['claude', 'CLAUDE_CONFIG_DIR', '/mnt/workspace/.claude'],
    ['kiro', 'XDG_DATA_HOME', '/home/node/.kiro-data'],
  ])(
    'preserves the configured %s conversation store in the launched environment',
    async (cli, variable, location) => {
      const driver = getDriver(cli);
      const result = await captureChild({
        command: process.execPath,
        args: ['-e', 'console.log(JSON.stringify(process.env))'],
        env: driver.envForAuth({ [variable]: location, AWS_ACCESS_KEY_ID: 'application-identity' }),
      });
      expect(JSON.parse(result.stdout)[variable]).toBe(location);
      expect(JSON.parse(result.stdout).AWS_ACCESS_KEY_ID).toBeUndefined();
    },
  );
  it('admits only provider-prepared inference IAM credentials through the session', async () => {
    const session = createCredentialSession({
      credentialEnvironment: {
        AWS_ACCESS_KEY_ID: 'inference-only',
        AWS_SECRET_ACCESS_KEY: 'fixture-secret',
        AWS_SESSION_TOKEN: 'fixture-session',
      },
    });
    try {
      const result = await session.run(() =>
        captureChild({
          command: process.execPath,
          args: ['-e', 'console.log(JSON.stringify(process.env))'],
          env: {
            AWS_ACCESS_KEY_ID: 'application-identity',
            AWS_CONTAINER_CREDENTIALS_FULL_URI: 'http://application-identity',
          },
        }),
      );
      const environment = JSON.parse(result.stdout);
      expect(environment.AWS_ACCESS_KEY_ID).toBe('inference-only');
      expect(environment.AWS_CONTAINER_CREDENTIALS_FULL_URI).toBeUndefined();
    } finally {
      await session.release();
    }
  });
  it('runs a runtime-owned process through the socket without exposing AWS identity in CLI configuration', async () => {
    const directory = await mkdtemp(path.join(tmpdir(), 'auth-bridge-test-'));
    const entry = path.join(directory, 'server.mjs');
    await writeFile(
      entry,
      `process.stdin.once('data', () => process.stdout.write(JSON.stringify({ identity: process.env.AWS_ACCESS_KEY_ID, inference: process.env.AWS_BEARER_TOKEN_BEDROCK ?? null, execution: process.env.V2_EXECUTION_ID }) + '\\n'));`,
    );
    const bridge = await createRuntimeMcpBridge({
      entry,
      runtimeEnv: {
        AWS_ACCESS_KEY_ID: 'runtime-only',
        AWS_BEARER_TOKEN_BEDROCK: 'must-be-scrubbed',
      },
      trustedEnv: { V2_EXECUTION_ID: 'e1' },
    });
    try {
      const response = await new Promise((resolve, reject) => {
        const socket = connect(bridge.socketPath, () => socket.write('request\n'));
        socket.on('error', reject);
        socket.once('data', (data) => {
          resolve(JSON.parse(data.toString()));
          socket.destroy();
        });
      });
      expect(response).toEqual({ identity: 'runtime-only', inference: null, execution: 'e1' });
    } finally {
      await bridge.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  });
  it.each(['claude', 'kiro', 'opencode', 'codex'])(
    'materializes the scoped relay for %s with no AWS forwarding',
    async (cli) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'auth-cli-test-'));
      const session = createCredentialSession();
      const mcpEntry = path.join(directory, 'fixture-mcp.mjs');
      await writeFile(
        mcpEntry,
        `
      import { McpServer } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/mcp.js'))};
      import { StdioServerTransport } from ${JSON.stringify(import.meta.resolve('@modelcontextprotocol/sdk/server/stdio.js'))};
      const server = new McpServer({ name: 'scope-fixture', version: '1.0.0' });
      server.tool('scope', {}, async () => ({ content: [{ type: 'text', text: process.env.V2_EXECUTION_ID }] }));
      await server.connect(new StdioServerTransport());
    `,
      );
      const client = new Client({ name: 'relay-protocol-test', version: '1.0.0' });
      try {
        const result = await session.run(() =>
          materializeCliContext({
            cli,
            workspaceDir: directory,
            mcpEntry,
            scope: { executionId: 'e1', intentId: 'e1', projectId: 'p1', stageId: 's1' },
            env: { V2_CODEX_HOME_ROOT: directory },
          }),
        );
        const serialized =
          cli === 'opencode'
            ? result.opencodeConfigContent
            : cli === 'codex'
              ? await readFile(path.join(result.codexHome, 'config.toml'), 'utf8')
              : cli === 'kiro'
                ? await readFile(
                    path.join(directory, '.kiro', 'agents', `${result.agentName}.json`),
                    'utf8',
                  )
                : await readFile(result.mcpConfigPath, 'utf8');
        expect(serialized).toContain('stdio-relay.js');
        expect(serialized).toContain('bridge.sock');
        expect(serialized).not.toContain('env_vars = ["AWS_ACCESS_KEY_ID"');
        expect(serialized).not.toContain('/runtime/mcp/index.js');
        expect(serialized).not.toContain(mcpEntry);
        let native;
        if (cli === 'codex') {
          const section = serialized.slice(serialized.indexOf('[mcp_servers."aidlc"]'));
          native = {
            command: JSON.parse(section.match(/^command = (.+)$/m)[1]),
            args: JSON.parse(section.match(/^args = (.+)$/m)[1]),
            env: {},
          };
        } else if (cli === 'opencode') {
          const config = JSON.parse(serialized).mcp.aidlc;
          native = {
            command: config.command[0],
            args: config.command.slice(1),
            env: config.environment,
          };
        } else native = JSON.parse(serialized).mcpServers.aidlc;
        await client.connect(
          new StdioClientTransport({
            ...native,
            env: childEnvironment(native.env),
            stderr: 'pipe',
          }),
        );
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain('scope');
        const answer = await client.callTool({
          name: 'scope',
          arguments: { executionId: 'attacker' },
        });
        expect(answer.content).toEqual([{ type: 'text', text: 'e1' }]);
      } finally {
        await client.close();
        await session.release();
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
  it.each(['claude', 'kiro', 'codex'])(
    'isolates concurrent %s configurations in the same workspace',
    async (cli) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'auth-concurrent-cli-'));
      const sessions = [createCredentialSession(), createCredentialSession()];
      try {
        const results = await Promise.all(
          sessions.map((session) =>
            session.run(() =>
              materializeCliContext({
                cli,
                workspaceDir: directory,
                mcpEntry: path.join(directory, 'unused.mjs'),
                scope: {
                  executionId: 'same-execution',
                  intentId: 'same-execution',
                  projectId: 'p1',
                },
                env: { V2_CODEX_HOME_ROOT: directory },
              }),
            ),
          ),
        );
        const configPaths = results.map((result) =>
          cli === 'claude'
            ? result.mcpConfigPath
            : cli === 'kiro'
              ? path.join(directory, '.kiro', 'agents', `${result.agentName}.json`)
              : path.join(result.codexHome, 'config.toml'),
        );
        expect(configPaths[0]).not.toBe(configPaths[1]);
        const secondConfig = await readFile(configPaths[1], 'utf8');
        await sessions[0].release();
        await expect(readFile(configPaths[0], 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
        expect(await readFile(configPaths[1], 'utf8')).toBe(secondConfig);
        expect(sessions[1].signal.aborted).toBe(false);
      } finally {
        await Promise.all(sessions.map((session) => session.release()));
        await rm(directory, { recursive: true, force: true });
      }
    },
  );
});

describe('alternate backend adapters', () => {
  it.each(['claude', 'opencode', 'codex'])(
    'configures an alternate endpoint and exact model for %s',
    (cli) => {
      const backend = createGatewayBackend({ endpoint: 'https://models.example/customer' });
      const driver = getDriver(cli, { backend });
      const invocation = driver.buildInvocation({ prompt: 'hello', model: 'customer-model' });
      const env = driver.envForAuth({
        AIDLC_GATEWAY_TOKEN: 'gateway-key',
        AWS_BEARER_TOKEN_BEDROCK: 'wrong-backend',
      });
      expect(JSON.stringify({ ...invocation, env })).not.toContain('amazon-bedrock');
      expect(JSON.stringify(env)).not.toContain('wrong-backend');
      expect(
        resolveStageModel({
          cli,
          cliModels: { [cli]: 'sonnet' },
          env: { BEDROCK_MODEL: 'ignored' },
          backend,
        }),
      ).toBe('sonnet');
      if (cli === 'claude') expect(env.ANTHROPIC_BASE_URL).toBe('https://models.example/customer');
      if (cli === 'opencode')
        expect(invocation.env.OPENCODE_CONFIG_CONTENT).toContain('https://models.example/customer');
      if (cli === 'codex')
        expect(invocation.args.join(' ')).toContain('https://models.example/customer');
    },
  );
});
