import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { prepareBedrockIamEnv } from '../bedrock-iam.js';
import { runChild, captureChild } from '../cli/spawn.js';
import { createRunStageStart } from '../commands/run-stage-start.js';
import { createBusyTracker, dispatchInvocation, invocationBusyTracker } from '../http-server.js';
import {
  credentialFailureError,
  credentialFailureResult,
  currentCredentialSignal,
  withCredentialSignal,
} from '../invocation-credentials.js';

const hour = 3600_000;
const handles = [];
const credentials = () => ({
  AccessKeyId: 'INERT',
  SecretAccessKey: 'inert-secret',
  Token: 'inert-token',
  Expiration: new Date(Date.now() + hour).toISOString(),
});
const prepare = async (renew, leaseMs = 8 * hour) => {
  const auth = await prepareBedrockIamEnv(
    {
      binding: {
        provider: 'bedrock',
        source: 'space',
        authType: 'iam',
        iam: { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' },
      },
      iamCredentials: credentials(),
      renewalToken: 'inert-renewal',
      renewalExpiresAt: Date.now() + leaseMs,
    },
    { renew },
  );
  handles.push(auth);
  return auth;
};
const silentChild = () => {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: vi.fn() };
  child.kill = vi.fn(); // Intentionally ignores SIGTERM and never emits close.
  return child;
};
const fakeClock = () => vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
afterEach(() => {
  for (const handle of handles.splice(0)) handle.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('IAM renewal failure lifecycle', () => {
  it('keeps the same child alive for three hours across credential rotations', async () => {
    fakeClock();
    const renew = vi.fn(async () => credentials());
    const auth = await prepare(renew);
    const child = silentChild();
    const spawnFn = vi.fn(() => child);
    const job = withCredentialSignal(auth.credentialSignal, () =>
      runChild({ command: 'claude', args: [], spawnFn }),
    );
    await vi.advanceTimersByTimeAsync(3 * hour);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(auth.credentialSignal.aborted).toBe(false);
    expect(spawnFn).toHaveBeenCalledTimes(1);
    expect(child.kill).not.toHaveBeenCalled();
    child.emit('close', 0);
    expect(await job).toMatchObject({ exitCode: 0 });
  });

  it('tolerates temporary renewal failures while the current credentials remain valid', async () => {
    fakeClock();
    const renew = vi
      .fn()
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockRejectedValueOnce(new Error('temporary outage'))
      .mockImplementation(async () => credentials());
    const auth = await prepare(renew);
    await vi.advanceTimersByTimeAsync(55 * 60_000);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(auth.credentialSignal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(6 * 60_000);
    expect(renew).toHaveBeenCalledTimes(3);
    expect(auth.credentialSignal.aborted).toBe(false);
  });

  it('ends a silent detached stage, sends one typed callback, and stops heartbeats after expiry', async () => {
    fakeClock();
    const auth = await prepare(
      vi.fn().mockRejectedValue(new Error('provider text must stay private')),
    );
    const child = silentChild();
    const sendCallbackSuccess = vi.fn(async () => ({ delivered: true }));
    const sendCallbackHeartbeat = vi.fn(async () => ({ delivered: true }));
    const busy = createBusyTracker();
    const activeJobs = new Map();
    const response = await dispatchInvocation({
      payload: {
        command: 'run-stage-start',
        executionId: 'e',
        stageId: 's',
        stageCallbackId: 'cb',
      },
      prepareInvocation: async () => auth,
      busy,
      handlers: {
        runStageStart: (payload, context) =>
          createRunStageStart({
            runStage: async () => {
              await runChild({ command: 'claude', args: [], spawnFn: () => child });
              return credentialFailureResult() ?? { ok: true };
            },
            sendCallbackSuccess,
            sendCallbackHeartbeat,
            busy: invocationBusyTracker(busy, context),
            activeJobs,
            log: () => {},
          })(payload),
      },
    });
    expect(response.body.accepted).toBe(true);
    expect(busy.status).toBe('HealthyBusy');
    expect(currentCredentialSignal()).toBeUndefined();
    await vi.advanceTimersByTimeAsync(59 * 60_000);
    expect(sendCallbackSuccess).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000 + 5000);
    expect(child.kill).toHaveBeenCalledWith('SIGTERM');
    expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    expect(sendCallbackSuccess).toHaveBeenCalledTimes(1);
    expect(sendCallbackSuccess).toHaveBeenCalledWith(
      'cb',
      expect.objectContaining({
        ok: false,
        state: 'FAILED',
        reason: 'bedrock_credentials_expired',
      }),
    );
    expect(JSON.stringify(sendCallbackSuccess.mock.calls)).not.toContain('provider text');
    expect(activeJobs.size).toBe(0);
    expect(busy.status).toBe('Healthy');
    const beats = sendCallbackHeartbeat.mock.calls.length;
    await vi.advanceTimersByTimeAsync(hour);
    expect(sendCallbackHeartbeat).toHaveBeenCalledTimes(beats);
    expect(sendCallbackSuccess).toHaveBeenCalledTimes(1);
  });

  it('reports expiry even if the refresh call never settles', async () => {
    fakeClock();
    const renew = vi.fn(() => new Promise(() => {}));
    const auth = await prepare(renew);
    await vi.advanceTimersByTimeAsync(hour);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(auth.credentialSignal.aborted).toBe(true);
    expect(credentialFailureResult(auth.credentialSignal).reason).toBe(
      'bedrock_credentials_expired',
    );
  });

  it('stops at the invocation authorization deadline even when STS credentials still work', async () => {
    fakeClock();
    const auth = await prepare(async () => credentials(), 30 * 60_000);
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(credentialFailureResult(auth.credentialSignal).reason).toBe(
      'bedrock_authorization_expired',
    );
  });

  it('does not cancel another invocation when one space loses its credentials', async () => {
    fakeClock();
    const a = await prepare(vi.fn().mockRejectedValue(new Error('denied')));
    const b = await prepare(async () => credentials());
    const childA = silentChild();
    const childB = silentChild();
    const jobA = withCredentialSignal(a.credentialSignal, () =>
      runChild({ command: 'claude', args: [], spawnFn: () => childA }),
    );
    const jobB = withCredentialSignal(b.credentialSignal, () =>
      captureChild({ command: 'codex', args: [], spawnFn: () => childB }),
    );
    await vi.advanceTimersByTimeAsync(hour + 5000);
    expect(await jobA).toMatchObject({ aborted: true });
    expect(b.credentialSignal.aborted).toBe(false);
    expect(childB.kill).not.toHaveBeenCalled();
    childB.emit('close', 0);
    expect(await jobB).toMatchObject({ exitCode: 0 });
  });

  it('does not signal failure or renew after normal invocation disposal', async () => {
    fakeClock();
    const renew = vi.fn(async () => credentials());
    const auth = await prepare(renew);
    auth.dispose();
    await vi.advanceTimersByTimeAsync(9 * hour);
    expect(renew).not.toHaveBeenCalled();
    expect(auth.credentialSignal.aborted).toBe(false);
  });
});

describe('child cancellation', () => {
  it('terminates a real process group whose parent and child both ignore SIGTERM', async () => {
    const controller = new AbortController();
    let ownedProcess;
    let output = '';
    const nestedScript = `
      process.on('SIGTERM', () => console.log('CHILD_TERM'));
      console.log('CHILD_READY');
      setInterval(() => {}, 1000);
    `;
    const script = `
      const { spawn } = require('node:child_process');
      process.on('SIGTERM', () => console.log('PARENT_TERM'));
      const child = spawn(process.execPath, ['-e', ${JSON.stringify(nestedScript)}], { stdio: ['ignore', 'pipe', 'pipe'] });
      child.stdout.pipe(process.stdout);
      setInterval(() => {}, 1000);
    `;
    try {
      const result = await runChild({
        command: process.execPath,
        args: ['-e', script],
        signal: controller.signal,
        abortGraceMs: 300,
        spawnFn: (...args) => {
          ownedProcess = spawn(...args);
          return ownedProcess;
        },
        onStdout: (chunk) => {
          output += chunk;
          if (output.includes('CHILD_READY') && !controller.signal.aborted) {
            controller.abort(credentialFailureError('bedrock_credentials_expired'));
          }
        },
      });
      expect(result.aborted).toBe(true);
      expect(output).toContain('PARENT_TERM');
      expect(output).toContain('CHILD_TERM');
      await vi.waitFor(() => expect(ownedProcess.signalCode).toBe('SIGKILL'));
    } finally {
      // Only the process group created above is ever targeted.
      if (ownedProcess?.pid) {
        try {
          process.kill(-ownedProcess.pid, 'SIGKILL');
        } catch {
          /* already exited */
        }
      }
    }
  });
  it.each([runChild, captureChild])('does not spawn after cancellation (%#)', async (run) => {
    const controller = new AbortController();
    controller.abort(credentialFailureError('bedrock_credentials_expired'));
    const spawnFn = vi.fn();
    const result = await withCredentialSignal(controller.signal, () =>
      run({ command: 'claude', args: [], spawnFn }),
    );
    expect(result.aborted).toBe(true);
    expect(spawnFn).not.toHaveBeenCalled();
  });

  it('kills the remaining process group even when the parent exits on SIGTERM', async () => {
    const controller = new AbortController();
    const child = silentChild();
    child.pid = 12345; // Only passed to the injected kill spy.
    const killProcessGroup = vi.fn((_pid, name) => {
      if (name === 'SIGTERM') child.emit('close', 0);
    });
    const job = runChild({
      command: 'claude',
      args: [],
      signal: controller.signal,
      spawnFn: () => child,
      killProcessGroup,
    });
    controller.abort(credentialFailureError('bedrock_credentials_expired'));
    expect(await job).toMatchObject({ aborted: true });
    expect(killProcessGroup.mock.calls).toEqual([
      [-12345, 'SIGTERM'],
      [-12345, 'SIGKILL'],
    ]);
  });
});
