import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { runSandboxWorker, violationEvent } from '../sandbox/worker.js';
import { harnessEnvironment } from '../sandbox/command.js';
import { DEFAULT_SANDBOX_CONFIG } from '../sandbox/launcher.js';

const settings = {
  network: { allowedDomains: [], deniedDomains: [], strictAllowlist: true },
  filesystem: { allowWrite: ['/work'], denyRead: [], denyWrite: [] },
};
const request = {
  command: '/usr/bin/fixture',
  args: ['argument with spaces', "'; touch /unwanted; '", '$(touch /unwanted)', 'a\nb'],
  env: { PATH: '/usr/bin', KIRO_API_KEY: 'fixture-secret' },
  settings,
  invocationId: 'invocation-1',
};
const fixtureManager = () => {
  let listener;
  let violations = [];
  let total = 0;
  return {
    initialize: vi.fn(),
    wrapWithSandboxArgv: vi.fn().mockResolvedValue({
      argv: ['/bin/bash', '-c', 'sandbox-wrapper'],
      env: { AWS_SECRET_ACCESS_KEY: 'runner-secret-must-not-reach-child' },
    }),
    cleanupAfterCommand: vi.fn(),
    reset: vi.fn(),
    getSandboxViolationStore: () => ({
      getTotalCount: () => total,
      subscribe: (callback) => {
        listener = callback;
        listener(violations);
        return () => {
          listener = null;
        };
      },
    }),
    add: (count, line) => {
      total += count;
      violations = [...violations, ...Array.from({ length: count }, () => ({ line }))].slice(-100);
      listener?.(violations);
    },
  };
};
const fixtureChild = () => {
  const child = new EventEmitter();
  child.kill = vi.fn(() => {
    child.emit('exit', null, 'SIGKILL');
  });
  return child;
};

describe('SRT worker', () => {
  it('keeps harness variables and arguments out of sandbox setup and preserves exit codes', async () => {
    const manager = fixtureManager();
    const child = fixtureChild();
    const spawnFn = vi.fn(() => {
      setImmediate(() => child.emit('exit', 7, null));
      return child;
    });
    expect(await runSandboxWorker(request, { manager, spawnFn })).toEqual({
      code: 7,
      signal: null,
    });
    expect(spawnFn).toHaveBeenCalledWith(
      '/bin/bash',
      ['-c', 'sandbox-wrapper'],
      expect.objectContaining({ shell: false, stdio: 'inherit' }),
    );
    expect(spawnFn.mock.calls[0][2].env.KIRO_API_KEY).toBeUndefined();
    expect(spawnFn.mock.calls[0][2].env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    const [wrappedCommand, , , , , correlation] = manager.wrapWithSandboxArgv.mock.calls[0];
    for (const argument of request.args) expect(wrappedCommand).not.toContain(argument);
    expect(wrappedCommand).not.toContain('fixture-secret');
    expect(correlation).toEqual({ commandId: 'invocation-1', commandText: 'agent invocation' });
    expect(manager.cleanupAfterCommand).toHaveBeenCalledOnce();
    expect(manager.reset).toHaveBeenCalledOnce();
  });

  it('protects and removes the launch file, without putting credentials in shell text', async () => {
    const manager = fixtureManager();
    let launchPath;
    manager.wrapWithSandboxArgv.mockImplementation(async (command) => {
      launchPath = /'([^']+\/command.json)'$/.exec(command)[1];
      expect(JSON.parse(readFileSync(launchPath, 'utf8'))).toMatchObject({
        command: request.command,
        args: request.args,
        env: request.env,
      });
      expect(manager.initialize.mock.calls[0][0].filesystem.denyWrite).toContain(
        launchPath.slice(0, -'/command.json'.length),
      );
      throw new Error('namespace denied');
    });
    await expect(runSandboxWorker(request, { manager })).rejects.toThrow('namespace denied');
    expect(existsSync(launchPath)).toBe(false);
  });

  it('passes literal argv and stdin through the entries without executing harness shell hooks outside', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'srt-entry-test-'));
    try {
      const hook = join(directory, 'hook.sh');
      const marker = join(directory, 'hook-ran');
      await writeFile(hook, `touch '${marker}'`);
      const manager = fixtureManager();
      // This test checks the actual entry scripts and OS argv handling. Linux
      // namespace enforcement is covered separately by the container test.
      manager.wrapWithSandboxArgv.mockImplementation(async (command) => ({
        argv: ['/bin/bash', '-c', command],
      }));
      let output = '';
      const result = await runSandboxWorker(
        {
          ...request,
          command: process.execPath,
          args: [
            '-e',
            "process.stdin.on('data', b => process.stdout.write(JSON.stringify({args:process.argv.slice(1),input:b.toString(),home:process.env.HOME})))",
            ...request.args,
          ],
          env: { ...request.env, BASH_ENV: hook, HOME: '/harness-state' },
        },
        {
          manager,
          spawnFn: (command, args, options) => {
            const child = spawn(command, args, { ...options, stdio: ['pipe', 'pipe', 'inherit'] });
            child.stdout.on('data', (chunk) => (output += chunk));
            child.stdin.end('prompt through stdin');
            return child;
          },
        },
      );
      expect(result.code).toBe(0);
      expect(JSON.parse(output)).toEqual({
        args: request.args,
        input: 'prompt through stdin',
        home: '/harness-state',
      });
      expect(existsSync(marker)).toBe(false);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('never launches unconfined when sandbox setup fails and still cleans up', async () => {
    const manager = fixtureManager();
    manager.wrapWithSandboxArgv.mockRejectedValue(new Error('namespace denied'));
    const spawnFn = vi.fn();
    await expect(runSandboxWorker(request, { manager, spawnFn })).rejects.toThrow(
      'namespace denied',
    );
    expect(spawnFn).not.toHaveBeenCalled();
    expect(manager.reset).toHaveBeenCalledOnce();
  });

  it('returns a nonzero exit when the harness is terminated by a signal', async () => {
    const manager = fixtureManager();
    manager.wrapWithSandboxArgv.mockImplementation(async (command) => ({
      argv: ['/bin/bash', '-c', command],
    }));
    const result = await runSandboxWorker(
      {
        ...request,
        command: process.execPath,
        args: ['-e', 'process.kill(process.pid, "SIGTERM")'],
      },
      { manager },
    );
    expect(result).toEqual({ code: 1, signal: null });
  });

  it.each(['enableWeakerNestedSandbox', 'allowNestedUserNamespaces'])(
    'rejects weaker Linux process isolation: %s',
    async (setting) => {
      const manager = fixtureManager();
      await expect(
        runSandboxWorker({ ...request, settings: { ...settings, [setting]: true } }, { manager }),
      ).rejects.toThrow('Invalid sandbox');
      expect(manager.initialize).not.toHaveBeenCalled();
    },
  );

  it.each([
    { policy: settings, permissive: false },
    { policy: DEFAULT_SANDBOX_CONFIG.settings, permissive: true },
  ])(
    'only approves unlisted destinations in permissive mode: $permissive',
    async ({ policy, permissive }) => {
      const manager = fixtureManager();
      const child = fixtureChild();
      await runSandboxWorker(
        { ...request, settings: policy },
        {
          manager,
          spawnFn: () => {
            setImmediate(() => child.emit('exit', 0, null));
            return child;
          },
        },
      );
      const approve = manager.initialize.mock.calls[0][1];
      if (permissive)
        await expect(approve({ host: 'example.invalid', port: 443 })).resolves.toBe(true);
      else expect(approve).toBeUndefined();
    },
  );

  it('forwards new violations once, keeps repeat counts and reports buffer gaps', async () => {
    const manager = fixtureManager();
    const child = fixtureChild();
    const events = [];
    const spawnFn = () => {
      manager.add(1, 'deny network-outbound example.invalid:443 (host is not on the allow list)');
      manager.add(1, 'deny network-outbound example.invalid:443 (host is not on the allow list)');
      manager.add(102, 'deny network-outbound example.invalid:443 (host is not on the allow list)');
      setImmediate(() => child.emit('exit', 0, null));
      return child;
    };
    await runSandboxWorker(request, { manager, spawnFn, emit: (event) => events.push(event) });
    expect(events.filter((event) => event.type === 'sandbox.denied')).toHaveLength(102);
    expect(events).toContainEqual({ type: 'sandbox.log_gap', count: 2 });
  });

  it('kills the wrapped command and cleans up on cancellation', async () => {
    const manager = fixtureManager();
    const child = fixtureChild();
    const controller = new AbortController();
    const promise = runSandboxWorker(request, {
      manager,
      spawnFn: () => {
        setImmediate(() => controller.abort());
        return child;
      },
      signal: controller.signal,
    });
    await expect(promise).resolves.toEqual({ code: null, signal: 'SIGKILL' });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(manager.reset).toHaveBeenCalledOnce();
  });

  it.each([
    ['cleanupAfterCommand', 'command', 0],
    ['cleanupAfterCommand', 'command', 7],
    ['reset', 'manager', 0],
    ['reset', 'manager', 7],
  ])('preserves the result when %s fails (step %s, exit %i)', async (method, step, code) => {
    const manager = fixtureManager();
    manager[method].mockImplementation(() => {
      throw new Error('cleanup error containing fixture-secret');
    });
    const child = fixtureChild();
    const emit = vi.fn();
    const result = await runSandboxWorker(request, {
      manager,
      emit,
      spawnFn: () => {
        setImmediate(() => child.emit('exit', code, null));
        return child;
      },
    });
    expect(result).toEqual({ code, signal: null });
    expect(emit).toHaveBeenCalledWith({ type: 'sandbox.cleanup_failed', step });
    expect(JSON.stringify(emit.mock.calls)).not.toContain('fixture-secret');
    expect(manager.reset).toHaveBeenCalledOnce();
    const launchPath = /'([^']+\/command.json)'$/.exec(
      manager.wrapWithSandboxArgv.mock.calls[0][0],
    )[1];
    expect(existsSync(launchPath)).toBe(false);
  });

  it('preserves the setup error when both cleanup steps also fail', async () => {
    const manager = fixtureManager();
    manager.initialize.mockRejectedValue(new Error('initialization failed'));
    manager.cleanupAfterCommand.mockImplementation(() => {
      throw new Error('cleanup failed');
    });
    manager.reset.mockRejectedValue(new Error('reset failed'));
    const emit = vi.fn();
    await expect(runSandboxWorker(request, { manager, emit })).rejects.toThrow(
      'initialization failed',
    );
    expect(manager.reset).toHaveBeenCalledOnce();
    expect(emit.mock.calls).toEqual([
      [{ type: 'sandbox.cleanup_failed', step: 'command' }],
      [{ type: 'sandbox.cleanup_failed', step: 'manager' }],
    ]);
  });
});

describe('in-sandbox environment', () => {
  it('changes only localhost in generated proxy URLs, preserving credentials and ports', () => {
    const generated = 'http://user%2Bname:p%40ss@localhost:3128';
    const result = harnessEnvironment({}, {}, { HTTP_PROXY: generated, grpc_proxy: generated });
    for (const value of Object.values(result)) {
      const proxy = new URL(value);
      expect(proxy.hostname).toBe('127.0.0.1');
      expect(proxy.port).toBe('3128');
      expect(proxy.username).toBe('user%2Bname');
      expect(proxy.password).toBe('p%40ss');
    }
  });

  it('retains harness state and credentials while giving SRT generated settings priority', () => {
    expect(
      harnessEnvironment(
        {
          HOME: '/harness',
          PATH: '/harness/bin',
          KIRO_API_KEY: 'fixture-secret',
          HTTP_PROXY: 'http://bypass.invalid',
          NO_PROXY: '*',
          REMOVED: 'must not survive',
        },
        { HOME: '/worker', PATH: '/usr/bin', REMOVED: 'set' },
        {
          HOME: '/worker',
          PATH: '/usr/bin',
          HTTP_PROXY: 'http://token@127.0.0.1:3128',
          NO_PROXY: 'localhost',
          SANDBOX_RUNTIME: '1',
        },
      ),
    ).toEqual({
      HOME: '/harness',
      PATH: '/harness/bin',
      KIRO_API_KEY: 'fixture-secret',
      HTTP_PROXY: 'http://token@127.0.0.1:3128',
      NO_PROXY: 'localhost',
      SANDBOX_RUNTIME: '1',
    });
  });
});

describe('SRT event redaction', () => {
  it('redacts known credentials and does not copy command attribution into events', () => {
    expect(
      violationEvent(
        {
          line: 'deny network-outbound example.invalid:443 (fixture-secret)',
          command: 'prompt with secret',
        },
        ['fixture-secret'],
      ),
    ).toEqual({
      type: 'sandbox.denied',
      source: 'proxy',
      host: 'example.invalid',
      port: 443,
      reason: '[REDACTED]',
    });
  });

  it('does not publish unknown messages that may contain URLs or credentials', () => {
    expect(violationEvent({ line: 'deny http-request GET https://x/?token=secret' })).toEqual({
      type: 'sandbox.observation',
      source: 'srt',
      detail: 'unclassified_violation',
    });
  });

  it('labels file observations as unconfirmed, and bounds untrusted text', () => {
    expect(violationEvent({ line: 'deny openat /protected/file' })).toEqual({
      type: 'sandbox.file_observation',
      source: 'linux_write_monitor',
      operation: 'openat',
      path: '/protected/file',
      confirmedDenial: false,
    });
    const event = violationEvent({ line: `deny openat /${'x'.repeat(300)}` });
    expect(event.path).toHaveLength(256);
  });
});
