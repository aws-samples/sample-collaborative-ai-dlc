import { describe, it, expect } from 'vitest';
import { EventEmitter } from 'node:events';
import {
  selectCli,
  getDriver,
  claudeDriver,
  kiroDriver,
  SUPPORTED_CLIS,
  buildKiroListSessions,
  parseLatestKiroSession,
} from '../cli/drivers.js';
import { runChild } from '../cli/spawn.js';

describe('selectCli', () => {
  it('uses the requested CLI when installed', () => {
    expect(selectCli({ requested: 'kiro', availableClis: ['claude', 'kiro'] })).toBe('kiro');
  });
  it('returns null for an explicit request that is NOT installed (no silent fallback)', () => {
    // The project's choice depends on which CLI is authed — running a different
    // CLI than requested would run the wrong agent, so this fails closed.
    expect(selectCli({ requested: 'kiro', availableClis: ['claude'] })).toBeNull();
  });
  it('falls back to preference order only when NO CLI is requested', () => {
    expect(selectCli({ availableClis: ['kiro'] })).toBe('kiro');
    expect(selectCli({ availableClis: ['claude', 'kiro'] })).toBe('claude');
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

  it('forces the session id up front when supplied (new-session-only)', () => {
    const inv = claudeDriver.buildInvocation({
      prompt: 'do it',
      mcpConfigPath: '/cfg.json',
      sessionId: 'sess-uuid-1',
    });
    const i = inv.args.indexOf('--session-id');
    expect(i).toBeGreaterThan(-1);
    expect(inv.args[i + 1]).toBe('sess-uuid-1');
  });

  it('omits --session-id when none is supplied', () => {
    const inv = claudeDriver.buildInvocation({ prompt: 'x', mcpConfigPath: '/cfg.json' });
    expect(inv.args).not.toContain('--session-id');
  });

  it('builds a resume invocation with --resume (never --session-id)', () => {
    const inv = claudeDriver.buildResumeInvocation({
      sessionId: 'sess-uuid-1',
      answerMessage: 'the human said yes',
      mcpConfigPath: '/cfg.json',
      model: 'us.anthropic.claude-sonnet-4-6',
    });
    expect(inv.command).toBe('claude');
    expect(inv.args).toEqual([
      '--resume',
      'sess-uuid-1',
      '-p',
      'the human said yes',
      '--mcp-config',
      '/cfg.json',
      '--permission-mode',
      'bypassPermissions',
      '--model',
      'us.anthropic.claude-sonnet-4-6',
      '--output-format',
      'stream-json',
      '--verbose',
    ]);
    expect(inv.args).not.toContain('--session-id');
  });
});

describe('kiro driver', () => {
  it('builds a headless chat invocation with trust-all-tools + --agent (no --mcp-config)', () => {
    const inv = kiroDriver.buildInvocation({ prompt: 'go', agentName: 'aidlc' });
    expect(inv.command).toBe('kiro-cli');
    expect(inv.args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--agent',
      'aidlc',
      'go',
    ]);
    // Kiro 2.10 has no --mcp-config flag — must not be emitted.
    expect(inv.args).not.toContain('--mcp-config');
  });
  it('passes the API key as auth env', () => {
    expect(kiroDriver.envForAuth({ KIRO_API_KEY: 'k' })).toEqual({ KIRO_API_KEY: 'k' });
    expect(kiroDriver.envForAuth({})).toEqual({});
  });

  it('builds a resume invocation with --agent + --resume-id', () => {
    const inv = kiroDriver.buildResumeInvocation({
      sessionId: 'kiro-sess-9',
      answerMessage: 'the human said go',
      agentName: 'aidlc',
    });
    expect(inv.command).toBe('kiro-cli');
    expect(inv.args).toEqual([
      'chat',
      '--no-interactive',
      '--trust-all-tools',
      '--agent',
      'aidlc',
      '--resume-id',
      'kiro-sess-9',
      'the human said go',
    ]);
    expect(inv.args).not.toContain('--mcp-config');
  });
});

describe('Kiro session capture', () => {
  it('lists sessions as JSON', () => {
    expect(buildKiroListSessions()).toEqual({
      command: 'kiro-cli',
      args: ['chat', '--list-sessions', '--format', 'json'],
    });
  });

  it('returns the newest session id for the cwd (by updatedAt)', () => {
    const stdout = JSON.stringify([
      {
        cwd: '/other',
        sessions: [{ sessionId: 'nope', updatedAt: '2026-06-29T23:00:00Z' }],
      },
      {
        cwd: '/mnt/workspace',
        sessions: [
          { sessionId: 'older', updatedAt: '2026-06-29T10:00:00Z' },
          { sessionId: 'newest', updatedAt: '2026-06-29T12:00:00Z' },
        ],
      },
    ]);
    expect(parseLatestKiroSession(stdout, '/mnt/workspace')).toBe('newest');
  });

  it('returns null on unparseable output or no session for the cwd', () => {
    expect(parseLatestKiroSession('not json', '/mnt/workspace')).toBeNull();
    expect(parseLatestKiroSession(JSON.stringify([]), '/mnt/workspace')).toBeNull();
    expect(
      parseLatestKiroSession(JSON.stringify([{ cwd: '/x', sessions: [] }]), '/mnt/workspace'),
    ).toBeNull();
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
    expect(await p).toEqual({ exitCode: 0, stderrTail: '' });
  });

  it('maps a spawn error to a null exit code', async () => {
    const child = fakeChild();
    const p = runChild({ command: 'x', args: [], spawnFn: () => child });
    child.emit('error', new Error('ENOENT'));
    expect(await p).toEqual({ exitCode: null, stderrTail: '' });
  });

  it('tees + buffers the stderr tail when captureStderrTail is set', async () => {
    const child = fakeChild();
    child.stderr = new EventEmitter();
    const p = runChild({ command: 'x', args: [], captureStderrTail: 1024, spawnFn: () => child });
    child.stderr.emit('data', Buffer.from('boom'));
    child.emit('close', 1);
    expect(await p).toEqual({ exitCode: 1, stderrTail: 'boom' });
  });

  it('clamps the buffered stderr tail to the last N bytes', async () => {
    const child = fakeChild();
    child.stderr = new EventEmitter();
    const p = runChild({ command: 'x', args: [], captureStderrTail: 4, spawnFn: () => child });
    child.stderr.emit('data', Buffer.from('0123456789'));
    child.emit('close', 0);
    expect(await p).toEqual({ exitCode: 0, stderrTail: '6789' });
  });

  it('tees stdout to an onStdout handler when provided', async () => {
    const child = fakeChild();
    child.stdout = new EventEmitter();
    const chunks = [];
    const p = runChild({
      command: 'x',
      args: [],
      onStdout: (chunk) => chunks.push(chunk),
      spawnFn: () => child,
    });
    child.stdout.emit('data', Buffer.from('live'));
    child.emit('close', 0);
    expect(await p).toEqual({ exitCode: 0, stderrTail: '' });
    expect(chunks).toEqual(['live']);
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
