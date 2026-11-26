import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { RuntimeClientError } from '@aws-sdk/client-bedrock-agentcore';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativeExecutionSupervisor,
  stopNativeExecutionSession,
} from '../execution-worker.js';
import { executionIdentity, executionRuntimeConfiguration } from '../execution-runtime.js';
import { nativeWriterGeneration } from '../execution-store.js';
import { createNativeExecutionFence } from '../../shared/native-execution-fence.js';
import {
  createNativeRecoveryCheckpoints,
  nativeRecoveryScope,
} from '../../shared/native-recovery-checkpoint.js';
import { serialFixture, SERIAL_SOURCE } from './execution-serial-fixtures.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const fixture = async ({ checkpoint = true } = {}) => {
  const f = serialFixture();
  await f.ready();
  const turn = await f.turn(1);
  const identity = executionIdentity(f.row());
  const publicManifest = await f.publications.read(identity, turn.receipt, { verifyFiles: true });
  const checkpointReceipt = {
    id: 'd'.repeat(64),
    sequence: 1,
    manifest: {
      key: `${nativeRecoveryScope(identity).prefix}manifests/${'d'.repeat(64)}.json`,
      versionId: 'checkpoint-version-one',
      sha256: 'd'.repeat(64),
      bytes: 1000,
    },
  };
  const checkpointManifest = {
    writerGeneration: 1,
    sequence: 1,
    publicationId: turn.receipt.id,
    interactionId: turn.interactionReceipt.id,
    nativeSessionId: turn.receipt.nativeSessionId,
    harness: f.configuration.harness,
    packageId: f.configuration.packageId,
    imageDigest: f.configuration.image.digest,
    configurationSha256: hash(JSON.stringify(executionRuntimeConfiguration(f.prepared, f.row()))),
    files: publicManifest.files.map(({ path, bytes, sha256 }) => ({
      scope: 'project',
      path,
      bytes,
      sha256,
    })),
  };
  const owner = await f.store.claim(f.bindingIdentity);
  const published = await f.store.publish({
    row: owner.row,
    publication: turn.receipt,
    interaction: turn.interactionReceipt,
    interactionContentSha256: turn.body.contentSha256,
    ...(checkpoint ? { checkpoint: checkpointReceipt } : {}),
  });
  await f.store.projected({ row: published });
  await f.respond();
  let current;
  let version = 0;
  const fence = createNativeExecutionFence({
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
    s3: {
      async send(command) {
        const p = command.input;
        if (command.constructor.name === 'GetObjectCommand') {
          if (!current) throw Object.assign(new Error('absent'), { name: 'NoSuchKey' });
          return {
            VersionId: `v${version}`,
            ETag: `"v${version}"`,
            Body: Readable.from([current]),
            ContentLength: current.length,
          };
        }
        if ((p.IfNoneMatch && current) || (p.IfMatch && p.IfMatch !== `"v${version}"`))
          throw Object.assign(new Error('raced'), { name: 'PreconditionFailed' });
        current = Buffer.from(p.Body);
        return { VersionId: `v${++version}` };
      },
    },
  });
  await fence.ensureActive(identity);
  let runtimeGeneration = 1;
  const calls = [];
  const ports = {
    store: f.store,
    preparationStore: f.preparationStore,
    now: f.now,
    fence,
    publications: { ...f.publications, read: vi.fn(f.publications.read.bind(f.publications)) },
    interactions: f.interactions,
    checkpoints: { read: vi.fn(async () => structuredClone(checkpointManifest)) },
    authorize: vi.fn(async () => {}),
    project: vi.fn(async () => {}),
    credentials: vi.fn(async (row) => ({
      ok: true,
      ...executionIdentity(row),
      source: SERIAL_SOURCE,
      model: { provider: 'bedrock', value: 'fresh-model-secret' },
      git: { username: 'git', password: 'fresh-git-secret' },
    })),
    stop: vi.fn(async ({ execution, recoveryId }) => {
      expect((await fence.read(identity)).state).toBe('FENCED');
      expect((await fence.read(identity)).recoveryId).toBe(recoveryId);
      expect(nativeWriterGeneration(f.row())).toBe(nativeWriterGeneration(execution));
      calls.push('stop-confirmed');
      return { confirmed: true, runtimeSessionId: identity.runtimeSessionId };
    }),
    invoke: vi.fn(async ({ execution, payload }) => {
      calls.push(payload.command);
      if (payload.command === 'native-status') {
        if (execution.lastRecoveryId)
          return {
            ...identity,
            writerGeneration: runtimeGeneration,
            status: 'recovery_ready',
            recovered: false,
            recoveryId: execution.lastRecoveryId,
            checkpointId: checkpointReceipt.id,
            sequence: 1,
            nativeSessionId: turn.receipt.nativeSessionId,
          };
        return {
          ...identity,
          writerGeneration: runtimeGeneration,
          status: 'publication_ready',
          recovered: true,
          sequence: 1,
          nativeSessionId: turn.receipt.nativeSessionId,
          receipt: turn.receipt,
          interaction: turn.interactionReceipt,
        };
      }
      if (payload.command === 'native-recover') {
        expect((await fence.read(identity)).writerGeneration).toBe(payload.writerGeneration);
        expect((await fence.read(identity)).checkpointId).toBe(checkpointReceipt.id);
        expect(f.row()).toMatchObject({ status: 'RECOVERING', recovery: { phase: 'RESTORING' } });
        expect(f.row().dispatch).toBeUndefined();
        runtimeGeneration = payload.writerGeneration;
        return {
          ...identity,
          writerGeneration: runtimeGeneration,
          status: 'recovery_ready',
          recovered: false,
          recoveryId: payload.recoveryId,
          checkpointId: checkpointReceipt.id,
          sequence: 1,
          nativeSessionId: turn.receipt.nativeSessionId,
        };
      }
      expect(payload.command).toBe('native-continue');
      expect(f.row().dispatch).toMatchObject({
        writerGeneration: runtimeGeneration,
        sequence: 2,
        commandId: payload.requestId,
      });
      return {
        ...identity,
        writerGeneration: runtimeGeneration,
        sequence: 2,
        requestId: payload.requestId,
        status: 'preparing',
      };
    }),
  };
  return {
    ...f,
    ports,
    turn,
    calls,
    checkpointReceipt,
    checkpointManifest,
    reconcile: createNativeExecutionSupervisor(ports),
  };
};

describe('same-session native writer recovery', () => {
  it('fences, positively stops, restores, then delivers the same saved reply under generation 2', async () => {
    const f = await fixture();
    const original = f.row();
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({ status: 'RECOVERING', recovery: { phase: 'FENCING' } });
    expect(f.ports.stop).not.toHaveBeenCalled();
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RECOVERING',
      writerGeneration: 2,
      recovery: { phase: 'RESTORING' },
    });
    expect(f.calls).toEqual(['native-status', 'stop-confirmed']);
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({ status: 'DISPATCHING', writerGeneration: 2 });
    expect(f.row().dispatch).toBeUndefined();
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      epoch: 1,
      writerGeneration: 2,
      runtimeSessionId: original.runtimeSessionId,
      attemptId: original.attemptId,
      target: original.target,
      publication: original.publication,
      response: { commandId: original.response.commandId, deliveryStatus: 'delivered' },
    });
    const payloads = f.ports.invoke.mock.calls.map(([call]) => call.payload);
    expect(payloads.filter((p) => p.command === 'native-continue')).toHaveLength(1);
    expect(payloads.some((p) => p.command === 'native-start')).toBe(false);
    expect(payloads.find((p) => p.command === 'native-recover')).toMatchObject({
      checkpoint: f.checkpointReceipt,
      writerGeneration: 2,
      sequence: 1,
      publication: original.publication,
      interaction: original.interaction,
    });
    expect(JSON.stringify(f.row())).not.toMatch(/fresh-model-secret|fresh-git-secret/);
  });
  it('recovers another idle loss between restore and dispatch from the same original checkpoint', async () => {
    const f = await fixture();
    const original = f.row();
    for (let index = 0; index < 3; index++) await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({ status: 'DISPATCHING', writerGeneration: 2 });
    expect(f.row().dispatch).toBeUndefined();
    const previousRecoveryId = f.row().lastRecoveryId;
    f.ports.invoke.mockImplementationOnce(async ({ execution, payload }) => {
      expect(payload.command).toBe('native-status');
      return {
        ...executionIdentity(execution),
        writerGeneration: 2,
        status: 'publication_ready',
        recovered: true,
        sequence: 1,
        nativeSessionId: original.publication.nativeSessionId,
        receipt: original.publication,
        interaction: original.interaction,
      };
    });
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RECOVERING',
      recovery: { phase: 'FENCING', previousGeneration: 2, writerGeneration: 3 },
    });
    expect(f.row().recovery.id).not.toBe(previousRecoveryId);
    await f.reconcile(f.identity);
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'DISPATCHING',
      writerGeneration: 3,
      recoveryCheckpoint: original.recoveryCheckpoint,
      response: original.response,
      target: original.target,
    });
    expect(f.row().dispatch).toBeUndefined();
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RUNNING',
      writerGeneration: 3,
      epoch: original.epoch,
      runtimeSessionId: original.runtimeSessionId,
      dispatch: { sequence: 2, writerGeneration: 3, commandId: original.response.commandId },
    });
    const payloads = f.ports.invoke.mock.calls.map(([call]) => call.payload);
    expect(payloads.filter((payload) => payload.command === 'native-continue')).toHaveLength(1);
    expect(
      payloads
        .filter((payload) => payload.command === 'native-recover')
        .map((payload) => ({
          checkpointId: payload.checkpoint.id,
          writerGeneration: payload.writerGeneration,
        })),
    ).toEqual([
      { checkpointId: original.recoveryCheckpoint.id, writerGeneration: 2 },
      { checkpointId: original.recoveryCheckpoint.id, writerGeneration: 3 },
    ]);
    expect(f.ports.stop).toHaveBeenCalledTimes(2);
  });
  it.each([undefined, true])(
    'does not accept recovery_ready without an explicit live owner (recovered=%s)',
    async (recovered) => {
      const f = await fixture();
      await f.reconcile(f.identity);
      await f.reconcile(f.identity);
      const actualInvoke = f.ports.invoke.getMockImplementation();
      f.ports.invoke.mockImplementationOnce(async (call) => {
        const ack = await actualInvoke(call);
        if (recovered === undefined) delete ack.recovered;
        else ack.recovered = recovered;
        return ack;
      });
      await f.reconcile(f.identity);
      expect(f.row()).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        recovery: { reason: 'RESTORE_FAILED', canRecover: true },
      });
      expect((await f.ports.fence.read(executionIdentity(f.row()))).state).toBe('FENCED');
      expect(f.ports.stop).toHaveBeenCalledTimes(2);
      expect(f.calls).not.toContain('native-continue');
    },
  );
  it('does not activate a replacement after an uncertain stop', async () => {
    const f = await fixture();
    await f.reconcile(f.identity);
    f.ports.stop.mockResolvedValueOnce({ confirmed: false });
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_STOP_UNCONFIRMED',
    });
    expect(f.row()).toMatchObject({ status: 'RECOVERING', recovery: { phase: 'FENCING' } });
    expect((await f.ports.fence.read(executionIdentity(f.row()))).state).toBe('FENCED');
    expect(f.calls).not.toContain('native-recover');
    f.tick();
    await f.reconcile(f.identity);
    expect(f.row().recovery.phase).toBe('RESTORING');
  });
  it.each(['NATIVE_RECOVERY_INVALID', 'NATIVE_RECOVERY_MISSING'])(
    'blocks %s after the predecessor stopped without activating or stopping a nonexistent successor',
    async (code) => {
      const f = await fixture();
      await f.reconcile(f.identity);
      await f.reconcile(f.identity);
      const restoring = f.row();
      const identity = executionIdentity(restoring);
      expect(restoring).toMatchObject({
        writerGeneration: 2,
        recovery: { phase: 'RESTORING', previousGeneration: 1 },
      });
      expect(await f.ports.fence.read(identity)).toMatchObject({
        state: 'FENCED',
        writerGeneration: 1,
        recoveryId: restoring.recovery.id,
      });
      f.ports.checkpoints.read.mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: 'CHECKPOINT_UNAVAILABLE',
      });
      expect(f.row().recovery.canRecover).toBe(false);
      expect(await f.ports.fence.read(identity)).toMatchObject({
        state: 'FENCED',
        writerGeneration: 1,
        recoveryId: f.row().recovery.id,
      });
      expect(f.ports.stop).toHaveBeenCalledTimes(1);
      expect(f.calls).not.toContain('native-recover');
      // A delayed old activation must not reopen the closed predecessor.
      await expect(
        f.ports.fence.activate(identity, {
          writerGeneration: 2,
          recoveryId: restoring.recovery.id,
          checkpointId: f.checkpointReceipt.id,
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_FENCE_CONFLICT' });
    },
  );
  it('resumes a crash between closing checkpoint admission and persisting blocked recovery', async () => {
    const f = await fixture();
    await f.reconcile(f.identity);
    await f.reconcile(f.identity);
    f.ports.checkpoints.read.mockRejectedValue(
      Object.assign(new Error('missing immutable version'), { code: 'NATIVE_RECOVERY_MISSING' }),
    );
    let rejectCommit = true;
    f.hooks.before = async (command) => {
      if (
        rejectCommit &&
        command.input?.TransactItems?.some(
          (item) =>
            item.Put?.Item?.sk === 'EXECUTION' && item.Put.Item.status === 'RECOVERY_REQUIRED',
        )
      ) {
        rejectCommit = false;
        throw new Error('table unavailable');
      }
    };
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_UNAVAILABLE',
    });
    const closed = await f.ports.fence.read(executionIdentity(f.row()));
    expect(closed).toMatchObject({
      state: 'FENCED',
      writerGeneration: 1,
      reason: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(f.row()).toMatchObject({ status: 'RECOVERING', recovery: { phase: 'RESTORING' } });
    f.tick();
    expect(await f.reconcile(f.identity)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(f.row().recovery.id).toBe(closed.recoveryId);
    expect(f.ports.stop).toHaveBeenCalledTimes(1);
    expect(f.calls).not.toContain('native-recover');
  });
  it.each(['DISPATCHING', 'RESTORING'])(
    'returns transient checkpoint reads to short polling at %s without changing writer authority',
    async (phase) => {
      const f = await fixture();
      if (phase === 'RESTORING') {
        await f.reconcile(f.identity);
        await f.reconcile(f.identity);
      }
      const before = f.row();
      const fence = await f.ports.fence.read(executionIdentity(before));
      const stopCount = f.ports.stop.mock.calls.length;
      f.ports.checkpoints.read.mockRejectedValueOnce(
        Object.assign(new Error('temporary storage outage'), {
          code: 'NATIVE_RECOVERY_UNAVAILABLE',
        }),
      );
      expect(await f.reconcile(f.identity)).toEqual({ pending: true, status: before.status });
      expect(f.row().leaseToken).toBeUndefined();
      expect(await f.ports.fence.read(executionIdentity(f.row()))).toEqual(fence);
      expect(f.ports.stop).toHaveBeenCalledTimes(stopCount);
      expect(f.calls).not.toContain('native-recover');
    },
  );
  it.each(['NoSuchVersion', 'NATIVE_PUBLICATION_INVALID'])(
    'verifies the pinned publication again before restore and blocks %s while predecessor stays closed',
    async (errorCode) => {
      const f = await fixture();
      await f.reconcile(f.identity);
      await f.reconcile(f.identity);
      f.ports.publications.read.mockRejectedValueOnce(
        Object.assign(new Error('unavailable publication'), {
          name: errorCode,
          code: errorCode,
        }),
      );
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: 'CHECKPOINT_UNAVAILABLE',
      });
      expect(f.ports.stop).toHaveBeenCalledTimes(1);
      expect(f.calls).not.toContain('native-recover');
      expect(await f.ports.fence.read(executionIdentity(f.row()))).toMatchObject({
        state: 'FENCED',
        writerGeneration: 1,
      });
    },
  );
  it.each(['empty', 'changed-size', 'changed-hash', 'extra-public'])(
    'rejects %s checkpoint project content before restore admission',
    async (kind) => {
      const f = await fixture();
      if (kind === 'empty') f.checkpointManifest.files = [];
      if (kind === 'changed-size') f.checkpointManifest.files[0].bytes++;
      if (kind === 'changed-hash') f.checkpointManifest.files[0].sha256 = '0'.repeat(64);
      if (kind === 'extra-public')
        f.checkpointManifest.files.push({
          ...f.checkpointManifest.files[0],
          path: 'src/extra-public.js',
        });
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: 'CHECKPOINT_UNAVAILABLE',
      });
      expect(f.calls).not.toContain('native-recover');
      expect(f.row().publication.id).toBe(f.turn.receipt.id);
    },
  );
  it('excludes private project directories and home files using publisher traversal visibility', async () => {
    const f = await fixture();
    f.checkpointManifest.files.push(
      { scope: 'home', path: '.codex/sessions/private.jsonl', bytes: 10, sha256: 'f'.repeat(64) },
      { scope: 'project', path: '.codex/private.jsonl', bytes: 10, sha256: 'f'.repeat(64) },
      {
        scope: 'project',
        path: 'aidlc/i/.aidlc-engine/writer.lock/private.json',
        bytes: 10,
        sha256: 'f'.repeat(64),
      },
    );
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({ status: 'RECOVERING', recovery: { phase: 'FENCING' } });
    expect(f.ports.publications.read).toHaveBeenCalledWith(
      expect.objectContaining({ epoch: 1 }),
      f.turn.receipt,
      { verifyFiles: true },
    );
  });
  it('cancellation after Stop wins before generation activation or restore', async () => {
    const f = await fixture();
    await f.reconcile(f.identity);
    f.ports.stop.mockImplementationOnce(async () => {
      await f.store.cancel(f.bindingIdentity);
      return { confirmed: true, runtimeSessionId: f.row().runtimeSessionId };
    });
    await expect(f.reconcile(f.identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_LEASE_LOST',
    });
    expect(f.row()).toMatchObject({ status: 'CANCEL_REQUESTED', epoch: 2 });
    expect(f.calls).not.toContain('native-recover');
  });
  it('cannot recover legacy public files without a committed private checkpoint', async () => {
    const f = await fixture({ checkpoint: false });
    expect(await f.reconcile(f.identity)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(f.row().recovery.canRecover).toBe(false);
    expect(f.ports.stop).toHaveBeenCalledOnce();
    expect(f.ports.credentials).not.toHaveBeenCalled();
  });
  it('does not replay an attempted reply even if cold status shows a prior completed checkpoint', async () => {
    const f = await fixture();
    const claim = await f.store.claim(f.bindingIdentity);
    const marked = await f.store.dispatchAttempted({ row: claim.row });
    await f.store.release({ row: marked });
    expect(await f.reconcile(f.identity)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'DELIVERY_UNCERTAIN',
    });
    expect(f.row().recovery.canRecover).toBe(false);
    expect(f.calls).toEqual(['native-status', 'stop-confirmed']);
  });
  it('finishes an interrupted uncertainty stop from its durable fence before marking the row terminal', async () => {
    const f = await fixture();
    const claim = await f.store.claim(f.bindingIdentity);
    await f.store.release({ row: await f.store.dispatchAttempted({ row: claim.row }) });
    f.ports.stop.mockRejectedValueOnce(
      Object.assign(new Error('unconfirmed stop transport'), { name: 'TimeoutError' }),
    );
    expect(await f.reconcile(f.identity)).toMatchObject({ pending: true, status: 'DISPATCHING' });
    const fence = await f.ports.fence.read(executionIdentity(f.row()));
    expect(fence).toMatchObject({ state: 'FENCED', reason: 'DELIVERY_UNCERTAIN' });
    expect(await f.reconcile(f.identity)).toMatchObject({
      status: 'RECOVERY_REQUIRED',
      reason: 'DELIVERY_UNCERTAIN',
    });
    expect(f.ports.stop.mock.calls[0][0].recoveryId).toBe(f.ports.stop.mock.calls[1][0].recoveryId);
    expect(f.calls.filter((command) => command === 'native-status')).toHaveLength(1);
    expect(f.calls).not.toContain('native-continue');
  });
  it.each([false, true])(
    'maps SDK RuntimeClientError to a fixed stopped state (attempted=%s)',
    async (attempted) => {
      const f = await fixture();
      if (attempted) {
        const claim = await f.store.claim(f.bindingIdentity);
        await f.store.release({ row: await f.store.dispatchAttempted({ row: claim.row }) });
      }
      f.ports.invoke.mockRejectedValueOnce(
        new RuntimeClientError({
          $metadata: { httpStatusCode: 424 },
          message: 'private upstream application HTTP409 body and credential text',
        }),
      );
      expect(await f.reconcile(f.identity)).toMatchObject({
        status: 'RECOVERY_REQUIRED',
        reason: attempted ? 'DELIVERY_UNCERTAIN' : 'SESSION_LOST',
      });
      expect(f.ports.stop).toHaveBeenCalledOnce();
      expect(JSON.stringify(f.row())).not.toMatch(/HTTP409|credential text|private upstream/);
      expect((await f.ports.fence.read(executionIdentity(f.row()))).state).toBe('FENCED');
    },
  );
  it('keeps an unconfirmed native-recover delivery in recovery review, not the RUNNING status retry path', async () => {
    const f = await fixture();
    await f.reconcile(f.identity);
    await f.reconcile(f.identity);
    expect(f.row()).toMatchObject({
      status: 'RECOVERING',
      recovery: { phase: 'RESTORING' },
      writerGeneration: 2,
    });
    f.ports.invoke.mockRejectedValueOnce(
      new RuntimeClientError({
        $metadata: { httpStatusCode: 424 },
        message: 'private recovery acknowledgement unavailable',
      }),
    );
    expect(await f.reconcile(f.identity)).toMatchObject({
      pending: false,
      status: 'RECOVERY_REQUIRED',
      reason: 'RESTORE_FAILED',
    });
    expect(f.ports.invoke.mock.calls.at(-1)[0].payload.command).toBe('native-recover');
    expect((await f.ports.fence.read(executionIdentity(f.row()))).state).toBe('FENCED');
    expect(f.ports.stop).toHaveBeenCalledTimes(2);
    expect(f.ports.credentials).not.toHaveBeenCalled();
  });
  it.each([
    'packageId',
    'configurationSha256',
    'imageDigest',
    'publicationId',
    'interactionId',
    'nativeSessionId',
    'writerGeneration',
  ])('stops safely without admitting restore after checkpoint %s mismatch', async (field) => {
    const f = await fixture();
    f.checkpointManifest[field] = field === 'writerGeneration' ? 2 : 'wrong-pin';
    await f.reconcile(f.identity);
    expect(f.row().status).not.toBe('RECOVERING');
    expect(f.row().recovery).toMatchObject({ reason: 'CHECKPOINT_UNAVAILABLE', canRecover: false });
    expect(f.ports.stop).toHaveBeenCalledOnce();
    expect(f.calls).not.toContain('native-recover');
    // Public evidence stays intact even when no private restore is admitted.
    expect(f.row().publication.id).toBe(f.turn.receipt.id);
  });
  it.each([1, 2])(
    'retains the confirmed stop episode across %s manual restore retries without replaying the reply',
    async (failures) => {
      const f = await fixture();
      const original = f.row();
      await f.reconcile(f.identity);
      await f.reconcile(f.identity);
      for (let failure = 0; failure < failures; failure++) {
        const previousEpisode = f.row().recovery.id;
        const failedReport = async ({ execution }) => ({
          ...executionIdentity(execution),
          writerGeneration: nativeWriterGeneration(execution),
          recoveryId: execution.recovery.id,
          checkpointId: f.checkpointReceipt.id,
          sequence: 1,
          status: 'failed',
        });
        f.ports.invoke.mockImplementationOnce(failedReport);
        f.ports.invoke.mockImplementationOnce(failedReport);
        await f.reconcile(f.identity);
        const required = f.row();
        const closed = await f.ports.fence.read(executionIdentity(required));
        expect(required).toMatchObject({
          status: 'RECOVERY_REQUIRED',
          recovery: { reason: 'RESTORE_FAILED', canRecover: true, id: closed.recoveryId },
        });
        expect(required.recovery.id).not.toBe(previousEpisode);
        const failedStop = f.ports.stop.mock.calls.at(-1)[0];
        expect(failedStop.recoveryId).toBe(required.recovery.id);
        await f.store.recover({
          ...f.bindingIdentity,
          request: {
            requestId: `88888888-8888-4888-8888-88888888888${failure}`,
            recoveryId: required.recovery.id,
          },
        });
        expect(f.row()).toMatchObject({
          status: 'RECOVERING',
          recovery: { id: closed.recoveryId, phase: 'FENCING' },
        });
        await f.reconcile(f.identity);
        expect(f.row()).toMatchObject({
          writerGeneration: failure + 3,
          recovery: { id: closed.recoveryId, phase: 'RESTORING' },
        });
        const retriedStop = f.ports.stop.mock.calls.at(-1)[0];
        expect(retriedStop.recoveryId).toBe(failedStop.recoveryId);
        // Exercise the actual Stop command adapter against both protected rows:
        // the failed cleanup and manual retry must use the same AWS token.
        const runtime = {
          send: vi.fn(async () => ({
            $metadata: { httpStatusCode: 200 },
            statusCode: 200,
            runtimeSessionId: original.runtimeSessionId,
          })),
        };
        for (const input of [failedStop, retriedStop])
          await stopNativeExecutionSession({
            ...input,
            runtime,
            abortSignal: AbortSignal.timeout(1000),
          });
        expect(runtime.send.mock.calls[0][0].input).toEqual(runtime.send.mock.calls[1][0].input);
      }
      const episode = f.row().recovery.id;
      await f.reconcile(f.identity);
      expect(f.row()).toMatchObject({
        status: 'DISPATCHING',
        writerGeneration: failures + 2,
        response: original.response,
        recoveryCheckpoint: original.recoveryCheckpoint,
      });
      expect(await f.ports.fence.read(executionIdentity(f.row()))).toMatchObject({
        state: 'ACTIVE',
        recoveryId: episode,
        writerGeneration: failures + 2,
      });
      await f.reconcile(f.identity);
      expect(f.calls.filter((command) => command === 'native-continue')).toHaveLength(1);
      expect(f.row()).toMatchObject({
        status: 'RUNNING',
        response: { commandId: original.response.commandId, deliveryStatus: 'delivered' },
      });
    },
  );
});

describe('AgentCore StopRuntimeSession confirmation', () => {
  it('uses the same token across worker retries and requires the exact returned session', async () => {
    const f = await fixture();
    const row = f.row();
    const runtime = {
      send: vi.fn(async () => ({
        $metadata: { httpStatusCode: 200 },
        statusCode: 200,
        runtimeSessionId: row.runtimeSessionId,
      })),
    };
    const input = {
      runtime,
      draft: f.prepared,
      execution: row,
      recoveryId: '99999999-9999-4999-8999-999999999999',
      abortSignal: AbortSignal.timeout(1000),
    };
    expect(await stopNativeExecutionSession(input)).toMatchObject({ confirmed: true });
    await stopNativeExecutionSession({ ...input, execution: { ...row, version: row.version + 3 } });
    expect(runtime.send.mock.calls[0][0].input).toEqual(runtime.send.mock.calls[1][0].input);
    expect(runtime.send.mock.calls[0][0].input).toMatchObject({
      agentRuntimeArn: row.target.runtimeArn,
      qualifier: row.target.endpoint,
      runtimeSessionId: row.runtimeSessionId,
      clientToken: expect.stringMatching(/^[a-f0-9]{64}$/),
    });
    runtime.send.mockResolvedValueOnce({
      $metadata: { httpStatusCode: 200 },
      statusCode: 200,
      runtimeSessionId: 'wrong-session',
    });
    await expect(stopNativeExecutionSession(input)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_STOP_UNCONFIRMED',
    });
    runtime.send.mockRejectedValueOnce(
      Object.assign(new Error('absent'), { name: 'ResourceNotFoundException' }),
    );
    await expect(stopNativeExecutionSession(input)).rejects.toMatchObject({
      name: 'ResourceNotFoundException',
    });
  });
});

it.each(['valid', 'corrupted', 'empty-project', 'changed-project', 'extra-public'])(
  'verifies actual immutable checkpoint versions and the complete public project before committing (%s)',
  async (kind) => {
    const f = serialFixture();
    await f.ready();
    const turn = await f.turn(1);
    const versions = new Map();
    const reads = [];
    let serial = 0;
    const checkpoints = createNativeRecoveryCheckpoints({
      bucket: f.configuration.publicationBucket,
      accountId: f.configuration.accountId,
      s3: {
        async send(command) {
          const p = command.input;
          if (command.constructor.name === 'PutObjectCommand') {
            const VersionId = `immutable-${++serial}`;
            versions.set(`${p.Key}:${VersionId}`, Buffer.from(p.Body));
            return { VersionId };
          }
          reads.push(p);
          const bytes = versions.get(`${p.Key}:${p.VersionId}`);
          if (!bytes) throw new Error('Unpinned checkpoint read');
          return {
            VersionId: p.VersionId,
            ContentLength: bytes.length,
            Body: Readable.from([bytes]),
          };
        },
      },
    });
    const content = Buffer.from('private CLI session resume bytes');
    const projectContent = Buffer.from(
      kind === 'changed-project' ? '// changed code\n' : '// turn 1\n',
    );
    const projectFile = {
      scope: 'project',
      path: 'src/game.js',
      mode: 0o600,
      mtimeNs: '1000000000',
      bytes: projectContent.length,
      sha256: hash(projectContent),
      content: projectContent,
    };
    const checkpoint = await checkpoints.publish({
      identity: executionIdentity(f.row()),
      writerGeneration: 1,
      sequence: 1,
      nativeSessionId: turn.receipt.nativeSessionId,
      harness: 'codex',
      packageId: f.configuration.packageId,
      imageDigest: f.configuration.image.digest,
      configurationSha256: hash(JSON.stringify(executionRuntimeConfiguration(f.prepared, f.row()))),
      publicationId: turn.receipt.id,
      interactionId: turn.interactionReceipt.id,
      continuation: { promptEvidence: null, priorAssistantSha256: 'f'.repeat(64) },
      filesystem: {
        schemaVersion: 1,
        harness: 'codex',
        harnessVersion: '0.145.0',
        nativeSessionId: turn.receipt.nativeSessionId,
        format: 'codex-rollout-jsonl-v1',
        project: '/mnt/native/project',
        home: `/home/node/.native-homes/${f.row().bindingId}/${f.row().attemptId}`,
        directories: [],
        hardlinks: [],
      },
      files: [
        {
          scope: 'home',
          path: '.codex/sessions/resume.jsonl',
          mode: 0o600,
          mtimeNs: '1000000000',
          bytes: content.length,
          sha256: hash(content),
          content,
        },
        ...(kind === 'empty-project' ? [] : [projectFile]),
        ...(kind === 'extra-public' ? [{ ...projectFile, path: 'extra-public.js' }] : []),
      ],
    });
    if (kind === 'corrupted')
      versions.get([...versions.keys()].find((key) => key.includes('/files/')))[0] ^= 1;
    const supervisor = createNativeExecutionSupervisor({
      store: f.store,
      preparationStore: f.preparationStore,
      now: f.now,
      publications: f.publications,
      interactions: f.interactions,
      checkpoints,
      authorize: async () => {},
      fence: { cancel: vi.fn(async () => {}) },
      stop: async ({ execution }) => ({
        confirmed: true,
        runtimeSessionId: execution.runtimeSessionId,
      }),
      invoke: async ({ execution }) => ({
        ...executionIdentity(execution),
        writerGeneration: 1,
        sequence: 1,
        status: 'publication_ready',
        receipt: turn.receipt,
        interaction: turn.interactionReceipt,
        checkpoint,
      }),
    });
    await supervisor(f.identity);
    if (kind !== 'valid') {
      expect(f.row()).toMatchObject({
        status: 'FAILED',
        failureCode: 'native_execution_publication_invalid',
      });
      expect(f.row().recoveryCheckpoint).toBeUndefined();
      expect(f.row().publication).toBeUndefined();
    } else {
      expect(f.row()).toMatchObject({ status: 'AWAITING_USER', recoveryCheckpoint: checkpoint });
      expect(reads).toHaveLength(3);
      expect(
        reads.every(
          (read) => read.VersionId && read.ExpectedBucketOwner === f.configuration.accountId,
        ),
      ).toBe(true);
      expect(JSON.stringify(f.row())).not.toContain(content.toString());
    }
  },
);
