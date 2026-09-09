import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HOOKS_DISABLED_ARGS,
  NO_HOOKS_PATH,
  runGitCommand,
  withGitHooksDisabled,
} from '../git-runner.js';

describe('withGitHooksDisabled', () => {
  it('prepends the hook override before the requested Git arguments', () => {
    const runner = vi.fn();
    const runGit = withGitHooksDisabled(runner);
    const args = ['checkout', '--detach', 'abc123'];

    runGit('git', args);

    expect(runner).toHaveBeenCalledWith('git', [
      '-c',
      'core.hooksPath=/dev/null',
      'checkout',
      '--detach',
      'abc123',
    ]);
    expect(args).toEqual(['checkout', '--detach', 'abc123']);
  });

  it('applies hook suppression exactly once to each command invocation', () => {
    const runner = vi.fn();
    const runGit = withGitHooksDisabled(runner);

    runGit('git', ['status']);
    runGit('git', ['commit', '-m', 'message']);

    expect(runner).toHaveBeenCalledTimes(2);
    for (const [, args] of runner.mock.calls) {
      expect(args.slice(0, 2)).toEqual(HOOKS_DISABLED_ARGS);
      expect(args.filter((arg) => arg === '-c')).toHaveLength(1);
      expect(args.filter((arg) => arg === `core.hooksPath=${NO_HOOKS_PATH}`)).toHaveLength(1);
    }
    expect(runner.mock.calls[0][1]).toEqual([...HOOKS_DISABLED_ARGS, 'status']);
    expect(runner.mock.calls[1][1]).toEqual([...HOOKS_DISABLED_ARGS, 'commit', '-m', 'message']);
  });

  it('forwards options, environment, and additional runner arguments by identity', () => {
    const runner = vi.fn();
    const runGit = withGitHooksDisabled(runner);
    const options = {
      cwd: '/workspace',
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    };
    const signal = new AbortController().signal;

    runGit('git', ['fetch', 'origin'], options, signal);

    expect(runner).toHaveBeenCalledOnce();
    expect(runner.mock.calls[0][2]).toBe(options);
    expect(runner.mock.calls[0][2].env).toBe(options.env);
    expect(runner.mock.calls[0][3]).toBe(signal);
  });

  it('invokes only the injected runner', () => {
    const injectedRunner = vi.fn();
    const runGit = withGitHooksDisabled(injectedRunner);

    runGit('custom-git', ['rev-parse', 'HEAD']);

    expect(injectedRunner).toHaveBeenCalledOnce();
    expect(injectedRunner).toHaveBeenCalledWith('custom-git', [
      ...HOOKS_DISABLED_ARGS,
      'rev-parse',
      'HEAD',
    ]);
  });

  it('does not double-wrap the production process runner', () => {
    expect(withGitHooksDisabled(runGitCommand)).toBe(runGitCommand);
  });

  it('propagates synchronous errors without wrapping them', () => {
    const error = new Error('runner failed');
    const runGit = withGitHooksDisabled(() => {
      throw error;
    });

    expect(() => runGit('git', ['status'])).toThrow(error);
  });

  it('preserves the injected runner return value exactly', () => {
    const result = Promise.resolve({ stdout: 'abc123\n', exitCode: 0 });
    const runGit = withGitHooksDisabled(() => result);

    expect(runGit('git', ['rev-parse', 'HEAD'])).toBe(result);
  });
});

describe('runGitCommand', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  const fakeChild = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    return child;
  };

  it('strips ambient repository and identity overrides while preserving credentials and ordinary environment', async () => {
    const ambient = {
      GIT_DIR: '/ambient/.git',
      GIT_WORK_TREE: '/ambient/worktree',
      GIT_INDEX_FILE: '/ambient/index',
      GIT_OBJECT_DIRECTORY: '/ambient/objects',
      GIT_ALTERNATE_OBJECT_DIRECTORIES: '/ambient/alternates',
      GIT_COMMON_DIR: '/ambient/common',
      GIT_PREFIX: 'ambient/',
      GIT_NAMESPACE: 'ambient',
      GIT_CEILING_DIRECTORIES: '/ambient',
      GIT_AUTHOR_NAME: 'Ambient Author',
      GIT_AUTHOR_EMAIL: 'ambient-author@example.test',
      GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
      GIT_COMMITTER_NAME: 'Ambient Committer',
      GIT_COMMITTER_EMAIL: 'ambient-committer@example.test',
      GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
    };
    for (const [key, value] of Object.entries(ambient)) vi.stubEnv(key, value);
    vi.stubEnv('AIDLC_GIT_RUNNER_TEST', 'inherited');
    const env = {
      GIT_ASKPASS: '/tmp/test-askpass',
      GIT_TERMINAL_PROMPT: '0',
      AIDLC_GIT_USERNAME: 'test-user',
      AIDLC_GIT_PASSWORD: 'test-credential-sentinel',
    };
    const originalOverrides = { ...env };
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = runGitCommand('git', ['clone', 'remote', '/workspace'], {
      env,
      spawnFn,
    });
    child.emit('close', 0);

    await expect(resultPromise).resolves.toMatchObject({ code: 0 });
    const options = spawnFn.mock.calls[0][2];
    expect(options.stdio).toEqual(['ignore', 'inherit', 'inherit']);
    expect(options.env).toMatchObject({
      ...env,
      PATH: process.env.PATH,
      AIDLC_GIT_RUNNER_TEST: 'inherited',
    });
    for (const [key, value] of Object.entries(ambient)) {
      expect(options.env).not.toHaveProperty(key);
      expect(process.env[key]).toBe(value);
    }
    expect(env).toEqual(originalOverrides);
  });

  it('preserves explicit per-command Git overrides after sanitizing the inherited environment', async () => {
    vi.stubEnv('GIT_INDEX_FILE', '/ambient/index');
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);

    const resultPromise = runGitCommand('git', ['status'], {
      env: { GIT_INDEX_FILE: '/explicit/index' },
      spawnFn,
    });
    child.emit('close', 0);

    await resultPromise;
    expect(spawnFn.mock.calls[0][2].env.GIT_INDEX_FILE).toBe('/explicit/index');
    expect(process.env.GIT_INDEX_FILE).toBe('/ambient/index');
  });

  it('owns process spawning and captures output for engine callers', async () => {
    vi.stubEnv('AIDLC_GIT_RUNNER_TEST', 'must-not-be-inherited');
    const child = fakeChild();
    const spawnFn = vi.fn(() => child);
    const env = { PATH: '/usr/bin', GIT_TERMINAL_PROMPT: '0' };
    const resultPromise = runGitCommand('git', ['status', '--porcelain'], {
      cwd: '/workspace',
      env,
      spawnFn,
      captureOutput: true,
      inheritEnv: false,
    });

    child.stdout.emit('data', Buffer.from(' M file.js\n'));
    child.stderr.emit('data', Buffer.from('warning\n'));
    child.emit('close', 0);

    await expect(resultPromise).resolves.toEqual({
      code: 0,
      exitCode: 0,
      stdout: ' M file.js\n',
      stderr: 'warning\n',
    });
    expect(spawnFn).toHaveBeenCalledOnce();
    expect(spawnFn).toHaveBeenCalledWith('git', [...HOOKS_DISABLED_ARGS, 'status', '--porcelain'], {
      cwd: '/workspace',
      shell: false,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  });

  it('resolves spawn failures as a null exit result', async () => {
    const spawnFn = vi.fn(() => {
      throw new Error('spawn failed');
    });

    await expect(
      runGitCommand('git', ['status'], { spawnFn, captureOutput: true }),
    ).resolves.toEqual({ code: null, exitCode: null, stdout: '', stderr: '' });
  });
});
