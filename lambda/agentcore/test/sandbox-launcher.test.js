import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { Logger } from '@aws-lambda-powertools/logger';
import { describe, expect, it, vi } from 'vitest';
import { captureChild, runChild } from '../cli/spawn.js';
import { currentSandbox, DEFAULT_SANDBOX_CONFIG, withSandbox } from '../sandbox/launcher.js';

const settings = {
  network: { strictAllowlist: true, allowedDomains: [], deniedDomains: [] },
  filesystem: { allowWrite: ['/work'], denyRead: [], denyWrite: [] },
};
const fakeWorker = () => {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', null));
    return true;
  });
  return child;
};

describe('sandbox launch context', () => {
  it.each([
    ['sandbox.starting', 'info'],
    ['sandbox.file_observation', 'info'],
    ['sandbox.denied', 'warn'],
    ['sandbox.cleanup_failed', 'warn'],
    ['sandbox.log_gap', 'warn'],
    ['sandbox.observation', 'warn'],
    ['sandbox.error', 'error'],
  ])('logs %s at %s and still delivers it to the event consumer', async (type, level) => {
    const logs = {
      info: vi.spyOn(Logger.prototype, 'info').mockImplementation(() => {}),
      warn: vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => {}),
      error: vi.spyOn(Logger.prototype, 'error').mockImplementation(() => {}),
    };
    const onEvent = vi.fn();
    const spawnFn = () => {
      const child = fakeWorker();
      child.send = () => {
        setImmediate(() => {
          child.emit('message', { type });
          child.emit('close', type === 'sandbox.error' ? 1 : 0);
        });
      };
      return child;
    };
    try {
      await withSandbox({ enabled: true, settings, onEvent }, () =>
        captureChild({ command: 'fixture', args: [], env: {}, spawnFn }),
      );
      expect(logs[level]).toHaveBeenCalledExactlyOnceWith(
        'sandbox event',
        expect.objectContaining({ type, invocationId: expect.any(String) }),
      );
      expect(onEvent).toHaveBeenCalledExactlyOnceWith(logs[level].mock.calls[0][1]);
      for (const other of Object.keys(logs).filter((key) => key !== level)) {
        expect(logs[other]).not.toHaveBeenCalled();
      }
    } finally {
      for (const log of Object.values(logs)) log.mockRestore();
    }
  });

  it('keeps concurrent settings separate and leaves ordinary commands unwrapped', async () => {
    const workers = [];
    const settingsByRun = ['first.invalid', 'second.invalid'].map((host) => ({
      ...settings,
      network: { ...settings.network, allowedDomains: [host] },
    }));
    const spawnFn = vi.fn((command, args, options) => {
      const child = fakeWorker();
      child.send = vi.fn((request, callback) => {
        workers.push({ command, args, options, request });
        callback();
        setImmediate(() => {
          child.emit('message', { type: 'sandbox.starting' });
          child.stdout.write(request.settings.network.allowedDomains[0]);
          child.emit('close', 0);
        });
      });
      return child;
    });
    const results = await Promise.all(
      settingsByRun.map((policy) =>
        withSandbox({ enabled: true, settings: policy }, async () => {
          await new Promise((resolve) => setImmediate(resolve));
          return captureChild({ command: 'codex', args: ['exec'], env: {}, spawnFn });
        }),
      ),
    );
    expect(results.map((result) => result.stdout)).toEqual(['first.invalid', 'second.invalid']);
    expect(new Set(workers.map(({ request }) => request.invocationId)).size).toBe(2);
    expect(new Set(workers.map(({ options }) => options.env.TMPDIR)).size).toBe(2);
    for (const { options, request } of workers) {
      expect(options.detached).toBe(true);
      expect(options.stdio).toContain('ipc');
      expect(existsSync(options.env.TMPDIR)).toBe(false);
      expect(request.settings.filesystem.allowWrite).toContain(options.env.TMPDIR);
    }
    expect(currentSandbox()).toBe(DEFAULT_SANDBOX_CONFIG);
    expect(currentSandbox().enabled).toBe(false);

    const directSpawn = vi.fn(() => {
      const child = fakeWorker();
      setImmediate(() => child.emit('close', 0));
      return child;
    });
    await captureChild({ command: 'codex', args: ['exec'], env: {}, spawnFn: directSpawn });
    expect(directSpawn.mock.calls[0].slice(0, 2)).toEqual(['codex', ['exec']]);
    expect(directSpawn.mock.calls[0][2].stdio).not.toContain('ipc');
  });

  it.each([captureChild, runChild])(
    'preserves stdin and reports setup failures without retrying',
    async (launch) => {
      const child = fakeWorker();
      let prompt = '';
      child.stdin.on('data', (chunk) => (prompt += chunk));
      let scratch;
      const spawnFn = vi.fn((command, args, options) => {
        scratch = options.env.TMPDIR;
        child.send = vi.fn(() => {
          setImmediate(() => {
            child.emit('message', { type: 'sandbox.error', code: 'sandbox_start_failed' });
            child.emit('close', 1);
          });
        });
        return child;
      });
      const result = await withSandbox({ enabled: true, settings }, () =>
        launch({
          command: 'claude',
          args: ['-p'],
          env: { ANTHROPIC_API_KEY: 'fixture-only', NODE_OPTIONS: '--bad-hook' },
          promptViaStdin: true,
          prompt: 'test prompt',
          spawnFn,
        }),
      );
      expect(result).toMatchObject({ exitCode: 1, sandboxError: 'sandbox_start_failed' });
      expect(prompt).toBe('test prompt');
      expect(spawnFn).toHaveBeenCalledOnce();
      expect(spawnFn.mock.calls[0][2].env.ANTHROPIC_API_KEY).toBeUndefined();
      expect(spawnFn.mock.calls[0][2].env.NODE_OPTIONS).toBeUndefined();
      expect(child.send.mock.calls[0][0].env.ANTHROPIC_API_KEY).toBe('fixture-only');
      expect(child.send.mock.calls[0][0].env.NODE_OPTIONS).toBeUndefined();
      expect(existsSync(scratch)).toBe(false);
    },
  );

  it.each(['callback', 'throw'])(
    'kills the worker and cleans up when IPC send fails: %s',
    async (mode) => {
      const child = fakeWorker();
      let scratch;
      const spawnFn = (command, args, options) => {
        scratch = options.env.TMPDIR;
        child.send = (request, callback) => {
          if (mode === 'throw') throw new Error('IPC failed');
          callback(new Error('IPC failed'));
        };
        return child;
      };
      const result = await withSandbox({ enabled: true, settings }, () =>
        captureChild({ command: 'kiro-cli', args: [], env: {}, spawnFn }),
      );
      expect(result.sandboxError).toBe('sandbox_start_failed');
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(existsSync(scratch)).toBe(false);
    },
  );

  it.each([captureChild, runChild])(
    'logs cleanup failures without relabeling the command as a start failure',
    async (launch) => {
      const onEvent = vi.fn();
      const spawnFn = () => {
        const child = fakeWorker();
        child.send = () => {
          setImmediate(() => {
            child.emit('message', { type: 'sandbox.starting' });
            child.emit('message', { type: 'sandbox.cleanup_failed', step: 'manager' });
            child.emit('close', 7);
          });
        };
        return child;
      };
      const result = await withSandbox({ enabled: true, settings, onEvent }, () =>
        launch({ command: 'claude', args: [], env: {}, spawnFn }),
      );
      expect(result.exitCode).toBe(7);
      expect(result.sandboxError).toBeUndefined();
      expect(onEvent).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'sandbox.cleanup_failed', step: 'manager' }),
      );
    },
  );

  it.each([captureChild, runChild])(
    'uses the enabled boolean even when settings are present',
    async (launch) => {
      const spawnFn = vi.fn(() => {
        const child = fakeWorker();
        setImmediate(() => child.emit('close', 0));
        return child;
      });
      await withSandbox({ enabled: false, settings }, () =>
        launch({ command: 'claude', args: ['--version'], env: {}, spawnFn }),
      );
      expect(spawnFn.mock.calls[0].slice(0, 2)).toEqual(['claude', ['--version']]);
      expect(spawnFn.mock.calls[0][2].stdio).not.toContain('ipc');
    },
  );

  it('does not interpret string booleans as enabling or disabling the sandbox', () => {
    expect(() => withSandbox({ enabled: 'false', settings }, () => {})).toThrow(
      'sandbox.enabled must be a boolean',
    );
  });
});
