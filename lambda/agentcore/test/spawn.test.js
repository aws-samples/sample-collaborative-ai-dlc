import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { captureChild, runChild } from '../cli/spawn.js';
import { createCredentialSession } from '../credential-session.js';

const HOUR = 3600_000;
const START = 1_000_000;
const PID = 123456;
const launchers = [
  ['runChild', runChild],
  ['captureChild', captureChild],
];

// Never exits on its own: only termination (or an explicit emit) settles it.
const hungChild = () => {
  const child = new EventEmitter();
  child.pid = PID;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn();
  return child;
};
const unavailable = (credentialError) => ({
  exitCode: null,
  stdout: '',
  stderr: '',
  stderrTail: '',
  timedOut: false,
  credentialError,
});

afterEach(() => vi.useRealTimers());

describe('children launched inside a credential session', () => {
  it.each(launchers)(
    '%s kills the owned process group on expiry and never spawns again',
    async (_name, launch) => {
      vi.useFakeTimers();
      vi.setSystemTime(START);
      const session = createCredentialSession({
        expiresAt: START + HOUR,
        expirationCode: 'fixture_credential_expired',
      });
      const child = hungChild();
      const spawnFn = vi.fn(() => child);
      const killProcessGroup = vi.fn();
      const launched = session.run(async () => {
        const first = launch({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup });
        await vi.advanceTimersByTimeAsync(HOUR);
        // Work already inside the session keeps running after expiry; a later
        // launch there must resolve with the reason rather than throw.
        return {
          first: await first,
          later: await launch({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup }),
        };
      });
      expect(spawnFn.mock.calls[0][2].detached).toBe(true);
      const { first, later } = await launched;
      expect(killProcessGroup).toHaveBeenCalledWith(-PID, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
      expect(first).toMatchObject({
        exitCode: null,
        credentialError: 'fixture_credential_expired',
      });
      expect(later).toEqual(unavailable('fixture_credential_expired'));
      expect(() =>
        session.run(() => launch({ command: 'fixture', args: [], env: {}, spawnFn })),
      ).toThrow();
      expect(spawnFn).toHaveBeenCalledOnce();
      await session.release();
    },
  );

  it.each(launchers)(
    '%s resolves with credentialError instead of throwing once the session is disposed',
    async (_name, launch) => {
      const session = createCredentialSession({ env: { KIRO_API_KEY: 'invocation-token' } });
      const spawnFn = vi.fn();
      const result = await session.run(async () => {
        await session.release();
        return launch({ command: 'fixture', args: [], env: {}, spawnFn });
      });
      expect(result).toEqual(unavailable('credential_session_disposed'));
      expect(spawnFn).not.toHaveBeenCalled();
    },
  );

  it.each(launchers)(
    '%s settles on cancellation even when the group has already exited',
    async (_name, launch) => {
      const session = createCredentialSession();
      const child = hungChild();
      const killProcessGroup = vi.fn(() => {
        throw Object.assign(new Error('kill ESRCH'), { code: 'ESRCH' });
      });
      const result = session.run(() =>
        launch({ command: 'fixture', args: [], env: {}, spawnFn: () => child, killProcessGroup }),
      );
      session.cancel(Object.assign(new Error('revoked'), { code: 'fixture_revoked' }));
      expect(await result).toMatchObject({ exitCode: null, credentialError: 'fixture_revoked' });
      expect(killProcessGroup).toHaveBeenCalledWith(-PID, 'SIGKILL');
      await session.release();
    },
  );

  it('kills the owned process group when captureChild times out', async () => {
    const session = createCredentialSession();
    const child = hungChild();
    const killProcessGroup = vi.fn();
    try {
      const result = await session.run(() =>
        captureChild({
          command: 'fixture',
          args: [],
          env: {},
          timeoutMs: 5,
          spawnFn: () => child,
          killProcessGroup,
        }),
      );
      expect(result).toMatchObject({ exitCode: null, timedOut: true });
      expect(result).not.toHaveProperty('credentialError');
      expect(killProcessGroup).toHaveBeenCalledWith(-PID, 'SIGKILL');
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      await session.release();
    }
  });

  it('does not detach on win32, where only the child itself can be killed', async () => {
    const platform = Object.getOwnPropertyDescriptor(process, 'platform');
    Object.defineProperty(process, 'platform', { ...platform, value: 'win32' });
    const session = createCredentialSession();
    try {
      const child = hungChild();
      const spawnFn = vi.fn(() => child);
      const killProcessGroup = vi.fn();
      const result = session.run(() =>
        captureChild({ command: 'fixture', args: [], env: {}, spawnFn, killProcessGroup }),
      );
      expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('detached');
      session.cancel();
      expect(await result).toMatchObject({ credentialError: 'credential_expired' });
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
      expect(killProcessGroup).not.toHaveBeenCalled();
    } finally {
      Object.defineProperty(process, 'platform', platform);
      await session.release();
    }
  });
});

describe('children launched without a credential session', () => {
  it('keeps engine commands in the runtime process group', async () => {
    const child = hungChild();
    const spawnFn = vi.fn(() => child);
    const result = runChild({ command: 'git', args: ['status'], env: {}, spawnFn });
    expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('detached');
    child.emit('close', 0);
    expect(await result).toEqual({ exitCode: 0, stderrTail: '' });
  });

  it('kills only the child when captureChild times out', async () => {
    const child = hungChild();
    const spawnFn = vi.fn(() => child);
    const killProcessGroup = vi.fn();
    const result = await captureChild({
      command: 'fixture',
      args: [],
      env: {},
      timeoutMs: 5,
      spawnFn,
      killProcessGroup,
    });
    expect(spawnFn.mock.calls[0][2]).not.toHaveProperty('detached');
    expect(result).toEqual({ exitCode: null, stdout: '', stderr: '', timedOut: true });
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(killProcessGroup).not.toHaveBeenCalled();
  });
});
