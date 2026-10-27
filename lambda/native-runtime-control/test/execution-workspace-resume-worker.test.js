import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { createNativeExecutionSupervisor } from '../execution-worker.js';
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
