import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeExecutionSupervisor,
  stopNativeExecutionSession,
} from '../execution-worker.js';
import { createNativeExecutionDiagnostics } from '../execution-diagnostics.js';
import { executionIdentity } from '../execution-runtime.js';
import { nativeWriterGeneration } from '../execution-store.js';
import { NATIVE_WORKSPACE_RECOVERY } from '../../shared/native-recovery-mode.js';
import { serialFixture } from './execution-serial-fixtures.js';

// Real authority transitions and immutable answer/publication codecs prepare
// the resumed owner. The journey suite covers its real HTTP/executor boundary.
const fixture = async ({ generation = 2 } = {}) => {
  const f = serialFixture();
  f.configuration.recoveryMode = NATIVE_WORKSPACE_RECOVERY;
  await f.ready();
  const publication = await f.publish();
  const accepted = await f.respond();
  for (let writer = 2; writer <= generation; writer++) {
    const claimed = await f.store.claim(f.bindingIdentity);
    const stopped = await f.store.recoveryRequired({
      row: claimed.row,
      reason: 'DELIVERY_UNCERTAIN',
      workflowResumeState: 'created',
      stoppedSessionId: claimed.row.runtimeSessionId,
    });
    await f.store.recover({
      ...f.bindingIdentity,
      request: {
        requestId: randomUUID(),
        recoveryId: stopped.recovery.id,
        confirmWorkspaceResume: true,
      },
    });
    const confirmed = await f.store.claim(f.bindingIdentity);
    const restoring = await f.store.recoveryStopped({ row: confirmed.row });
    const resumed = await f.store.recovered({ row: restoring });
    await f.store.release({ row: resumed });
  }
  let savedFence = { state: 'ACTIVE', writerGeneration: generation };
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    authorize: vi.fn(async () => {}),
    credentials: vi.fn(),
    fence: {
      read: vi.fn(async () => structuredClone(savedFence)),
      ensureActive: vi.fn(async () => structuredClone(savedFence)),
      suspend: vi.fn(async (_identity, options) => {
        savedFence = { state: 'FENCED', ...options };
        return structuredClone(savedFence);
      }),
      cancel: vi.fn(async () => {
        savedFence = { ...savedFence, state: 'CANCELLED' };
        return structuredClone(savedFence);
      }),
      activate: vi.fn(),
    },
    invoke: vi.fn(async ({ execution }) => ({
      ...executionIdentity(execution),
      writerGeneration: nativeWriterGeneration(execution),
      status: 'stopped_needs_review',
      code: 'native_execution_existing_owner',
      workflowResumeState: 'created',
    })),
    stop: vi.fn(async ({ execution }) => ({
      confirmed: true,
      runtimeSessionId: execution.runtimeSessionId,
    })),
  };
  return {
    ...f,
    publication,
    accepted,
    ports,
    reconcile: createNativeExecutionSupervisor(ports),
  };
};

describe('confirmed workspace predecessor stop', () => {
  it.each([1, 2])(
    'uses writer %s stop evidence when the member confirms after the session is gone',
    async (generation) => {
      const f = await fixture({ generation });
      const original = f.row();
      const gone = Object.assign(new Error('previously stopped session no longer exists'), {
        name: 'ResourceNotFoundException',
        $metadata: { httpStatusCode: 404 },
      });
      const runtime = {
        send: vi
          .fn()
          .mockResolvedValueOnce({
            $metadata: { httpStatusCode: 200 },
            statusCode: 200,
            runtimeSessionId: original.runtimeSessionId,
          })
          .mockRejectedValue(gone),
      };
      const reconcile = createNativeExecutionSupervisor({
        ...f.ports,
        stop: (input) => stopNativeExecutionSession({ ...input, runtime }),
      });
      await expect(reconcile(f.identity)).resolves.toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
      });
      const stopped = f.row();
      expect(stopped.stopConfirmation).toEqual({
        writerGeneration: generation,
        runtimeSessionId: original.runtimeSessionId,
        confirmedAt: f.now(),
      });
      expect(runtime.send).toHaveBeenCalledTimes(1);
      f.tick(6 * 24 * 60 * 60 * 1000);
      const request = {
        requestId: randomUUID(),
        recoveryId: stopped.recovery.id,
        confirmWorkspaceResume: true,
      };
      await f.api.recover(f.prepared, request, f.recheck);
      await expect(reconcile(f.identity)).resolves.toMatchObject({
        pending: true,
        status: 'RECOVERING',
      });
      expect(f.row()).toMatchObject({
        writerGeneration: generation + 1,
        recovery: { id: request.recoveryId, phase: 'RESTORING' },
        publication: original.publication,
        stopConfirmation: stopped.stopConfirmation,
      });
      // The persistent proof belongs to the same writer/session. Confirmation
      // fences and rechecks ownership but never repeats that completed stop.
      expect(runtime.send).toHaveBeenCalledTimes(1);
      expect(f.ports.fence.suspend).toHaveBeenLastCalledWith(
        executionIdentity(stopped),
        expect.objectContaining({
          writerGeneration: generation,
          recoveryId: request.recoveryId,
        }),
      );
      expect(f.ports.fence.activate).not.toHaveBeenCalled();
      expect(f.ports.credentials).not.toHaveBeenCalled();
      expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
        'native-status',
      ]);
      expect(f.row().response).toBeUndefined();
      expect(await f.store.response(original, f.accepted.response.interactionId)).toEqual(
        f.accepted.response,
      );
      const after = f.row();
      await f.api.recover(f.prepared, request, f.recheck);
      expect(f.row()).toEqual(after);
    },
  );

  it.each([
    [1, 'missing'],
    [1, 'unconfirmed'],
    [1, 'wrong-session'],
    [2, 'missing'],
    [2, 'unconfirmed'],
    [2, 'wrong-session'],
  ])('requires a positive current stop for writer %s (%s)', async (generation, result) => {
    const f = await fixture({ generation });
    const before = f.row();
    const runtime = {
      send: vi.fn(async () => {
        if (result === 'missing')
          throw Object.assign(new Error('no positive stop evidence'), {
            name: 'ResourceNotFoundException',
            $metadata: { httpStatusCode: 404 },
          });
        return {
          $metadata: { httpStatusCode: 200 },
          statusCode: result === 'unconfirmed' ? 202 : 200,
          runtimeSessionId: result === 'wrong-session' ? randomUUID() : before.runtimeSessionId,
        };
      }),
    };
    const reconcile = createNativeExecutionSupervisor({
      ...f.ports,
      stop: (input) => stopNativeExecutionSession({ ...input, runtime }),
    });
    await expect(reconcile(f.identity)).rejects.toMatchObject(
      result === 'missing'
        ? { name: 'ResourceNotFoundException' }
        : { code: 'NATIVE_EXECUTION_STOP_UNCONFIRMED' },
    );
    expect(runtime.send).toHaveBeenCalledTimes(1);
    expect(f.row().writerGeneration).toBe(generation);
    expect(f.row().stopConfirmation).toEqual(before.stopConfirmation);
    expect(f.row().status).toBe(before.status);
    expect(f.row().publication).toEqual(before.publication);
    expect(f.ports.fence.activate).not.toHaveBeenCalled();
    expect(f.ports.credentials).not.toHaveBeenCalled();
    await expect(
      f.api.recover(
        f.prepared,
        {
          requestId: randomUUID(),
          recoveryId: randomUUID(),
          confirmWorkspaceResume: true,
        },
        f.recheck,
      ),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CONFLICT' });
    expect(await f.store.response(before, f.accepted.response.interactionId)).toEqual(
      f.accepted.response,
    );
  });

  it.each(['cancel', 'lease-takeover'])(
    'rechecks %s after fencing even with a confirmed predecessor stop',
    async (change) => {
      const f = await fixture({ generation: 1 });
      await f.reconcile(f.identity);
      const stopped = f.row();
      await f.api.recover(
        f.prepared,
        {
          requestId: randomUUID(),
          recoveryId: stopped.recovery.id,
          confirmWorkspaceResume: true,
        },
        f.recheck,
      );
      const suspend = f.ports.fence.suspend.getMockImplementation();
      let successor;
      f.ports.fence.suspend.mockImplementationOnce(async (...args) => {
        const result = await suspend(...args);
        if (change === 'cancel') await f.api.cancel(f.prepared, f.recheck);
        else {
          f.tick();
          expect((await f.store.claim(f.bindingIdentity)).kind).toBe('claimed');
        }
        successor = f.row();
        return result;
      });
      await expect(f.reconcile(f.identity)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_LEASE_LOST',
      });
      expect(f.row()).toEqual(successor);
      expect(f.row().writerGeneration).toBe(1);
      expect(f.row().stopConfirmation).toEqual(stopped.stopConfirmation);
      if (change === 'cancel') {
        expect(f.row()).toMatchObject({ status: 'CANCEL_REQUESTED', epoch: 2 });
        expect(f.row().workspaceResume).toBeUndefined();
      }
      expect(f.ports.stop).toHaveBeenCalledTimes(1);
      expect(f.ports.fence.activate).not.toHaveBeenCalled();
      expect(f.ports.credentials).not.toHaveBeenCalled();
      expect(f.ports.invoke).toHaveBeenCalledTimes(1);
      expect(await f.store.response(stopped, f.accepted.response.interactionId)).toEqual(
        f.accepted.response,
      );
    },
  );

  it('does not bypass the Stop adapter runtime pin check with a prior confirmation', async () => {
    const f = await fixture({ generation: 1 });
    await f.reconcile(f.identity);
    const stopped = f.row();
    await f.api.recover(
      f.prepared,
      {
        requestId: randomUUID(),
        recoveryId: stopped.recovery.id,
        confirmWorkspaceResume: true,
      },
      f.recheck,
    );
    const runtime = { send: vi.fn() };
    const reconcile = createNativeExecutionSupervisor({
      ...f.ports,
      preparationStore: {
        get: async () => ({ ...f.prepared, runtimeArn: `${f.prepared.runtimeArn}changed` }),
      },
      stop: (input) => stopNativeExecutionSession({ ...input, runtime }),
    });
    await expect(reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_RUNTIME_MISMATCH',
    });
    expect(runtime.send).not.toHaveBeenCalled();
    expect(f.row()).toMatchObject({
      writerGeneration: 1,
      recovery: { phase: 'FENCING' },
      stopConfirmation: stopped.stopConfirmation,
    });
    expect(f.ports.fence.activate).not.toHaveBeenCalled();
    expect(f.ports.credentials).not.toHaveBeenCalled();
  });
});

describe('workspace recovery control diagnostics', () => {
  it.each(['NoSuchKey', 'NotFound'])(
    'does not report an expected absent fence (%s) as a failed control operation',
    async (name) => {
      const f = await fixture();
      f.ports.fence.read.mockRejectedValueOnce(Object.assign(new Error('absent'), { name }));
      const events = [];
      const reconcile = createNativeExecutionSupervisor({
        ...f.ports,
        diagnostics: (event) => events.push(event),
      });
      expect(await reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
      });
      expect(events.some((event) => event.operation === 'fence-read')).toBe(false);
      expect(f.ports.stop).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    'authority-read',
    'authority-claim',
    'preparation-read',
    'authorization',
    'image-policy',
    'fence-read',
    'fence-suspend',
    'authority-recovery-stopped',
  ])('identifies a failed %s without advancing the fenced writer', async (operation) => {
    const f = await fixture({ generation: 1 });
    const claimed = await f.store.claim(f.bindingIdentity);
    const stopped = await f.store.recoveryRequired({
      row: claimed.row,
      reason: 'SESSION_LOST',
      workflowResumeState: 'created',
      stoppedSessionId: claimed.row.runtimeSessionId,
    });
    await f.store.recover({
      ...f.bindingIdentity,
      request: {
        requestId: randomUUID(),
        recoveryId: stopped.recovery.id,
        confirmWorkspaceResume: true,
      },
    });
    const before = f.row();
    f.ports.fence.read.mockResolvedValue({
      state: 'FENCED',
      writerGeneration: 1,
      recoveryId: before.recovery.id,
      reason: 'SESSION_LOST',
      workflowResumeState: 'created',
    });
    const canary = 'private-command-provider-body-and-credentials-do-not-log';
    const requestId = randomUUID();
    const error = Object.assign(new Error(canary), {
      name: 'AccessDeniedException',
      $metadata: { httpStatusCode: 403, requestId },
      providerBody: canary,
    });
    const denied = vi.fn(async () => {
      throw error;
    });
    const ports = {
      ...f.ports,
      store: { ...f.store },
      preparationStore: { ...f.preparationStore },
    };
    if (operation === 'authority-read') ports.store.get = denied;
    if (operation === 'authority-claim') ports.store.claim = denied;
    if (operation === 'preparation-read') ports.preparationStore.get = denied;
    if (operation === 'authorization') ports.authorize = denied;
    if (operation === 'image-policy') ports.imagePolicy = { revocation: denied };
    if (operation === 'fence-read') ports.fence.read = denied;
    if (operation === 'fence-suspend') ports.fence.suspend = denied;
    if (operation === 'authority-recovery-stopped') ports.store.recoveryStopped = denied;
    const lines = [];
    ports.diagnostics = createNativeExecutionDiagnostics({
      scope: f.identity,
      logger: { info: (line) => lines.push(line) },
    });
    const reconcile = createNativeExecutionSupervisor(ports);
    await expect(reconcile(f.identity)).rejects.toBe(error);
    expect(denied).toHaveBeenCalledTimes(1);
    expect(lines.map((line) => JSON.parse(line))).toEqual([
      expect.objectContaining({
        event: 'native_execution_diagnostic',
        scopeHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        phase: ['authority-read', 'authority-claim'].includes(operation) ? 'unknown' : 'recover',
        stage: 'call',
        code: 'CALL_FAILED',
        operation,
        errorName: error.name,
        errorCode: 'unknown',
        httpStatus: error.$metadata.httpStatusCode,
        awsRequestId: requestId,
      }),
    ]);
    expect(lines.join('\n')).not.toContain(canary);
    expect(lines.join('\n')).not.toContain(before.runtimeSessionId);
    expect(lines.join('\n')).not.toContain(f.identity.projectId);
    expect(f.row()).toMatchObject({
      status: 'RECOVERING',
      writerGeneration: 1,
      recovery: { id: before.recovery.id, phase: 'FENCING' },
      publication: before.publication,
      stopConfirmation: before.stopConfirmation,
    });
    expect(ports.fence.activate).not.toHaveBeenCalled();
    expect(ports.credentials).not.toHaveBeenCalled();
    expect(ports.invoke).not.toHaveBeenCalled();
    expect(await f.store.response(before, f.accepted.response.interactionId)).toEqual(
      f.accepted.response,
    );
  });
});

describe('interrupted acknowledged workspace resume', () => {
  it('requires another confirmed recovery without replaying the accepted answer', async () => {
    const f = await fixture();
    const before = f.row();
    expect(before).toMatchObject({
      status: 'RUNNING',
      writerGeneration: 2,
      workspaceResume: { id: before.lastRecoveryId, sequence: 2, writerGeneration: 2 },
    });
    expect(before.dispatch).toBeUndefined();
    expect(await f.reconcile(f.identity)).toEqual({
      pending: false,
      status: 'RECOVERY_REQUIRED',
      reason: 'DELIVERY_UNCERTAIN',
    });
    expect(f.row()).toMatchObject({
      writerGeneration: 2,
      publication: f.publication.receipt,
      recovery: { canRecover: true },
      stopConfirmation: { writerGeneration: 2, runtimeSessionId: before.runtimeSessionId },
    });
    expect(f.row().recovery.id).not.toBe(before.lastRecoveryId);
    expect(f.ports.fence.suspend).toHaveBeenCalledWith(executionIdentity(before), {
      writerGeneration: 2,
      recoveryId: f.row().recovery.id,
      reason: 'DELIVERY_UNCERTAIN',
      workflowResumeState: 'created',
    });
    expect(f.ports.fence.cancel).not.toHaveBeenCalled();
    expect(f.ports.fence.activate).not.toHaveBeenCalled();
    expect(f.ports.credentials).not.toHaveBeenCalled();
    expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
      'native-status',
    ]);
    expect(await f.store.response(before, f.accepted.response.interactionId)).toEqual(
      f.accepted.response,
    );
    expect(await f.reconcile(f.identity)).toMatchObject({ pending: false });
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
    expect(f.ports.invoke).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'missing-episode', 'wrong-episode', 'stale-turn', 'stale-generation'])(
    'does not treat a %s resume pointer as current in-flight work',
    async (change) => {
      const f = await fixture({ generation: change === 'stale-generation' ? 3 : 2 });
      const before = f.row();
      const stored = [...f.rows.values()].find(
        (row) => row.pk === before.pk && row.sk === before.sk,
      );
      if (change === 'missing') delete stored.workspaceResume;
      if (change === 'missing-episode') delete stored.lastRecoveryId;
      if (change === 'wrong-episode') stored.workspaceResume.id = randomUUID();
      if (change === 'stale-turn') stored.workspaceResume.sequence = 1;
      if (change === 'stale-generation') stored.workspaceResume.writerGeneration = 2;
      // Retained/absent pointers are readable authority states; they cannot
      // establish admission for this current turn and writer generation.
      await f.store.get(f.identity);
      expect(await f.reconcile(f.identity)).toEqual({
        pending: false,
        status: 'FAILED',
        failureCode: 'native_execution_runtime_mismatch',
      });
      expect(f.row().recovery).toBeUndefined();
      expect(f.row().publication).toEqual(f.publication.receipt);
      expect(f.ports.fence.suspend).not.toHaveBeenCalled();
      expect(f.ports.fence.activate).not.toHaveBeenCalled();
      expect(f.ports.fence.cancel).toHaveBeenCalledTimes(1);
      expect(f.ports.stop).toHaveBeenCalledTimes(1);
    },
  );

  it.each(
    ['status', 'stop'].flatMap((boundary) =>
      ['cancel', 'lease-takeover'].map((change) => ({ boundary, change })),
    ),
  )(
    'lets $change during $boundary preserve the successor authority',
    async ({ boundary, change }) => {
      const f = await fixture();
      const port = boundary === 'status' ? f.ports.invoke : f.ports.stop;
      const original = port.getMockImplementation();
      let successor;
      port.mockImplementationOnce(async (input) => {
        const result = await original(input);
        if (change === 'cancel') await f.store.cancel(f.bindingIdentity);
        else {
          f.tick();
          expect((await f.store.claim(f.bindingIdentity)).kind).toBe('claimed');
        }
        successor = f.row();
        return result;
      });
      await expect(f.reconcile(f.identity)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_LEASE_LOST',
      });
      expect(f.row()).toEqual(successor);
      expect(f.row().recovery).toBeUndefined();
      expect(f.ports.stop).toHaveBeenCalledTimes(boundary === 'stop' ? 1 : 0);
      expect(f.ports.fence.suspend).toHaveBeenCalledTimes(boundary === 'stop' ? 1 : 0);
      expect(f.ports.fence.activate).not.toHaveBeenCalled();
      expect(f.ports.credentials).not.toHaveBeenCalled();
      if (change === 'cancel') {
        expect(await f.reconcile(f.identity)).toEqual({ pending: false, status: 'CANCELLED' });
        expect(f.row()).toMatchObject({ status: 'CANCELLED', epoch: 2 });
      }
      expect(f.ports.invoke).toHaveBeenCalledTimes(1);
    },
  );

  it.each([undefined, { confirmed: false }, { confirmed: true, runtimeSessionId: 'foreign' }])(
    'keeps the writer fenced without authorizing recovery after stop %j',
    async (acknowledgement) => {
      const f = await fixture();
      f.ports.stop.mockResolvedValueOnce(acknowledgement);
      await expect(f.reconcile(f.identity)).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_STOP_UNCONFIRMED',
      });
      expect(f.row()).toMatchObject({
        status: 'RUNNING',
        writerGeneration: 2,
        stopConfirmation: { writerGeneration: 1 },
      });
      expect(f.row().recovery).toBeUndefined();
      expect(await f.ports.fence.read()).toMatchObject({
        state: 'FENCED',
        writerGeneration: 2,
        reason: 'DELIVERY_UNCERTAIN',
      });
      expect(f.ports.fence.cancel).not.toHaveBeenCalled();
      expect(f.ports.fence.activate).not.toHaveBeenCalled();
      expect(f.ports.credentials).not.toHaveBeenCalled();
      f.tick();
      expect(await f.reconcile(f.identity)).toEqual({
        pending: false,
        status: 'RECOVERY_REQUIRED',
        reason: 'DELIVERY_UNCERTAIN',
      });
      expect(f.row()).toMatchObject({
        writerGeneration: 2,
        recovery: { canRecover: true },
        stopConfirmation: { writerGeneration: 2 },
      });
      expect(f.ports.stop).toHaveBeenCalledTimes(2);
      expect(f.ports.invoke.mock.calls.map(([input]) => input.payload.command)).toEqual([
        'native-status',
      ]);
    },
  );
});
