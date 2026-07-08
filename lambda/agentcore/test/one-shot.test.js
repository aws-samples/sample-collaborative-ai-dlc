import { describe, it, expect, vi } from 'vitest';
import { runOneShotPrompt, parseClaudeOneShot, extractJsonObject } from '../cli/one-shot.js';
import { EventEmitter } from 'node:events';

// Fake child factory for captureChild: emits the given stdout/stderr then closes.
const fakeChild = ({ exitCode = 0, stdout = '', stderr = '' } = {}) => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => {
    if (stdout) child.stdout.emit('data', Buffer.from(stdout));
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', exitCode);
  });
  return child;
};

describe('parseClaudeOneShot', () => {
  it('extracts the result text and token usage from stream-json lines', () => {
    const stdout = [
      '{"type":"system","subtype":"init"}',
      '{"type":"assistant","message":{"content":[{"type":"text","text":"partial"}],"usage":{"input_tokens":100,"output_tokens":20}}}',
      '{"type":"result","result":"{\\"gist\\":\\"g\\"}","usage":{"input_tokens":120,"output_tokens":30}}',
      'not json',
    ].join('\n');
    const out = parseClaudeOneShot(stdout);
    expect(out.text).toBe('{"gist":"g"}');
    expect(out.metrics).toEqual({ tokensInput: 120, tokensOutput: 30 });
  });

  it('degrades to empty text / null metrics on garbage', () => {
    expect(parseClaudeOneShot('nothing structured')).toEqual({
      text: '',
      metrics: null,
      resultSubtype: null,
    });
  });
});

describe('extractJsonObject', () => {
  it('parses a bare JSON object', () => {
    expect(extractJsonObject('{"gist":"x","claims":["a"]}')).toEqual({ gist: 'x', claims: ['a'] });
  });
  it('parses a fenced JSON object wrapped in prose', () => {
    const text = 'Here you go:\n```json\n{"gist":"y"}\n```\nDone.';
    expect(extractJsonObject(text)).toEqual({ gist: 'y' });
  });
  it('parses an object embedded in prose without a fence', () => {
    expect(extractJsonObject('Sure! {"gist":"z"} hope that helps')).toEqual({ gist: 'z' });
  });
  it('returns null for unparseable or non-object answers', () => {
    expect(extractJsonObject('no json here')).toBeNull();
    expect(extractJsonObject('[1,2]')).toBeNull();
  });
});

describe('runOneShotPrompt', () => {
  it('returns no_cli when nothing usable is installed', async () => {
    const out = await runOneShotPrompt({ prompt: 'p', availableClis: [] });
    expect(out).toMatchObject({ ok: false, reason: 'no_cli', cli: null });
  });

  it('honours an explicit CLI request strictly (no silent fallback)', async () => {
    const out = await runOneShotPrompt({
      prompt: 'p',
      requestedCli: 'claude',
      availableClis: ['kiro'],
    });
    expect(out).toMatchObject({ ok: false, reason: 'no_cli' });
  });

  it('runs claude without an mcp-config and parses text + tokens', async () => {
    let argv;
    const spawnFn = vi.fn((command, args) => {
      argv = { command, args };
      return fakeChild({
        stdout:
          '{"type":"result","result":"{\\"gist\\":\\"the gist\\"}","usage":{"input_tokens":50,"output_tokens":10}}',
      });
    });
    const out = await runOneShotPrompt({
      prompt: 'summarize',
      availableClis: ['claude'],
      cliModels: { claude: 'us.anthropic.claude-haiku-4-5' },
      env: { AWS_REGION: 'us-east-1' },
      spawnFn,
    });
    expect(out).toMatchObject({
      ok: true,
      cli: 'claude',
      text: '{"gist":"the gist"}',
      metrics: { tokensInput: 50, tokensOutput: 10 },
    });
    expect(argv.command).toBe('claude');
    expect(argv.args).not.toContain('--mcp-config');
    expect(argv.args).toContain('--model');
    // The resolver region-prefixes bare aliases but passes full ids through.
    expect(argv.args[argv.args.indexOf('--model') + 1]).toBe('us.anthropic.claude-haiku-4-5');
  });

  it('runs kiro, strips ANSI from stdout, and captures the credit footer', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({
        stdout: '\u001B[38;5;141mThe answer\u001B[0m {"gist":"k"}',
        stderr: ' ▸ Credits: 0.12 • Time: 1s',
      }),
    );
    const restoreKiroStore = vi.fn(async () => true);
    const persistKiroStore = vi.fn(async () => true);
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['kiro'],
      spawnFn,
      restoreKiroStore,
      persistKiroStore,
    });
    expect(out.ok).toBe(true);
    expect(out.cli).toBe('kiro');
    expect(out.text).toContain('{"gist":"k"}');
    expect(out.text).not.toContain('\u001B');
    expect(out.metrics).toEqual({ credits: 0.12 });
    // Kiro's SQLite store is bracketed exactly like resolve-conflict.
    expect(restoreKiroStore).toHaveBeenCalledOnce();
    expect(persistKiroStore).toHaveBeenCalledOnce();
  });

  it('claude one-shots never touch the kiro store', async () => {
    const restoreKiroStore = vi.fn();
    const persistKiroStore = vi.fn();
    const spawnFn = vi.fn(() =>
      fakeChild({ stdout: '{"type":"result","result":"x","usage":{"output_tokens":1}}' }),
    );
    await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['claude'],
      spawnFn,
      restoreKiroStore,
      persistKiroStore,
    });
    expect(restoreKiroStore).not.toHaveBeenCalled();
    expect(persistKiroStore).not.toHaveBeenCalled();
  });

  it('maps a non-zero exit to cli_failed with no metrics and a diagnosable sample', async () => {
    const spawnFn = vi.fn(() => fakeChild({ exitCode: 1, stdout: 'boom: credentials missing' }));
    const out = await runOneShotPrompt({ prompt: 'p', availableClis: ['claude'], spawnFn });
    expect(out).toMatchObject({ ok: false, reason: 'cli_failed', exitCode: 1, metrics: null });
    expect(out.sample).toContain('boom: credentials missing');
  });

  it('maps an empty answer to empty_answer with the raw sample + result subtype', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({
        stdout: '{"type":"result","subtype":"error_max_turns","usage":{"input_tokens":5}}',
      }),
    );
    const out = await runOneShotPrompt({ prompt: 'p', availableClis: ['claude'], spawnFn });
    expect(out).toMatchObject({
      ok: false,
      reason: 'empty_answer',
      resultSubtype: 'error_max_turns',
    });
    expect(out.sample).toContain('error_max_turns');
  });

  it('SIGKILLs a hung CLI after timeoutMs and reports timeout (never wedges derive)', async () => {
    // A child that emits nothing and never closes on its own.
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = vi.fn();
    const spawnFn = vi.fn(() => child);
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['claude'],
      timeoutMs: 20,
      spawnFn,
    });
    expect(out).toMatchObject({ ok: false, reason: 'timeout', exitCode: null, metrics: null });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  });

  it('a fast answer never trips the watchdog', async () => {
    const spawnFn = vi.fn(() =>
      fakeChild({ stdout: '{"type":"result","result":"quick","usage":{"output_tokens":1}}' }),
    );
    const out = await runOneShotPrompt({
      prompt: 'p',
      availableClis: ['claude'],
      timeoutMs: 5_000,
      spawnFn,
    });
    expect(out).toMatchObject({ ok: true, text: 'quick' });
  });
});
