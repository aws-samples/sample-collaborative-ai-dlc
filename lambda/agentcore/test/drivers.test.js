import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import { selectCli, getDriver, claudeDriver, kiroDriver, SUPPORTED_CLIS } from '../cli/drivers.js';
import { runChild } from '../cli/spawn.js';

describe('selectCli', () => {
  it('prefers the requested CLI when installed', () => {
    expect(selectCli({ requested: 'kiro', availableClis: ['claude', 'kiro'] })).toBe('kiro');
  });
  it('falls back to preference order when the request is absent', () => {
    expect(selectCli({ requested: 'kiro', availableClis: ['claude'] })).toBe('claude');
    expect(selectCli({ availableClis: ['kiro'] })).toBe('kiro');
  });
  it('returns null when nothing is installed', () => {
    expect(selectCli({ availableClis: [] })).toBeNull();
    expect(selectCli({ requested: 'claude', availableClis: ['opencode'] })).toBeNull();
  });
  it('preference order is claude then kiro', () => {
    expect(SUPPORTED_CLIS).toEqual(['claude', 'kiro']);
  });
});

describe('claude driver', () => {
  it('builds a headless invocation with mcp-config, bypass perms, model, stream-json', () => {
    const inv = claudeDriver.buildInvocation({
      prompt: 'do it',
      mcpConfigPath: '/ws/.aidlc/mcp-config.json',
      model: 'us.anthropic.claude-sonnet-4-6',
      allowedTools: ['mcp__aidlc__create_artifact'],
    });
    expect(inv.command).toBe('claude');
    expect(inv.args).toEqual([
      '-p',
      'do it',
      '--mcp-config',
      '/ws/.aidlc/mcp-config.json',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'us.anthropic.claude-sonnet-4-6',
      '--allowedTools',
      'mcp__aidlc__create_artifact',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(inv.promptViaStdin).toBe(false);
  });

  it('sets Bedrock auth env, including the bearer token when present', () => {
    const env = claudeDriver.envForAuth({
      AWS_REGION: 'eu-west-1',
      AWS_BEARER_TOKEN_BEDROCK: 'tok',
    });
    expect(env).toMatchObject({
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_REGION: 'eu-west-1',
      IS_SANDBOX: '1',
      AWS_BEARER_TOKEN_BEDROCK: 'tok',
    });
  });

  it('omits the bearer token when not configured', () => {
    expect(
      claudeDriver.envForAuth({ AWS_REGION: 'us-east-1' }).AWS_BEARER_TOKEN_BEDROCK,
    ).toBeUndefined();
  });
});

describe('kiro driver', () => {
  it('builds a headless chat invocation with trust-all-tools + mcp-config', () => {
    const inv = kiroDriver.buildInvocation({ prompt: 'go', mcpConfigPath: '/cfg.json' });
    expect(inv.command).toBe('kiro-cli');
    expect(inv.args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--mcp-config',
      '/cfg.json',
      'go',
    ]);
  });
  it('passes the API key as auth env', () => {
    expect(kiroDriver.envForAuth({ KIRO_API_KEY: 'k' })).toEqual({ KIRO_API_KEY: 'k' });
    expect(kiroDriver.envForAuth({})).toEqual({});
  });
});

describe('getDriver', () => {
  it('throws on an unsupported CLI', () => {
    expect(() => getDriver('opencode')).toThrow(/unsupported CLI/);
  });
});

describe('runChild — exit contract', () => {
  // A fake child the test drives to a close/error event.
  const fakeChild = () => {
    const c = new EventEmitter();
    c.stdin = { end() {} };
    return c;
  };

  it('resolves the exit code on close', async () => {
    const child = fakeChild();
    const p = runChild({ command: 'x', args: [], spawnFn: () => child });
    child.emit('close', 0);
    expect(await p).toEqual({ exitCode: 0 });
  });

  it('maps a spawn error to a null exit code', async () => {
    const child = fakeChild();
    const p = runChild({ command: 'x', args: [], spawnFn: () => child });
    child.emit('error', new Error('ENOENT'));
    expect(await p).toEqual({ exitCode: null });
  });

  it('pipes the prompt to stdin when promptViaStdin', async () => {
    const child = fakeChild();
    let piped = null;
    child.stdin = { end: (v) => (piped = v) };
    const p = runChild({
      command: 'x',
      args: [],
      prompt: 'hello',
      promptViaStdin: true,
      spawnFn: () => child,
    });
    child.emit('close', 0);
    await p;
    expect(piped).toBe('hello');
  });
});
