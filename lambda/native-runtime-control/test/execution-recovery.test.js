import { randomUUID } from 'node:crypto';
import { TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { nativePublicationScope } from '../../shared/native-publication.js';
import { createNativeExecutionApi, nativeExecutionView } from '../execution-api.js';
import { executionIdentity } from '../execution-runtime.js';
import { nativeWriterGeneration } from '../execution-store.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR } from './fixtures.js';
import { verifyPublicProjectFiles } from '../execution-lifecycle.js';

it('binds publication visibility to the exact checkpoint filesystem policy', () => {
  const source = { scope: 'project', path: 'package-lock.json', sha256: 'a'.repeat(64), bytes: 1 };
  const dependency = { ...source, path: 'node_modules/pkg/index.js' };
  const publication = { filesystemPolicy: 'node-dependencies-v1', files: [source] };
  const checkpoint = {
    filesystem: { filesystemPolicy: 'node-dependencies-v1' },
    files: [source, dependency],
  };
  expect(() => verifyPublicProjectFiles(checkpoint, publication)).not.toThrow();
  expect(() => verifyPublicProjectFiles({ ...checkpoint, filesystem: {} }, publication)).toThrow();
  expect(() => verifyPublicProjectFiles(checkpoint, { files: [source, dependency] })).toThrow();
  expect(() => verifyPublicProjectFiles(checkpoint, { ...publication, files: [] })).toThrow();
  expect(() =>
    verifyPublicProjectFiles({ files: [source, dependency] }, { files: [source, dependency] }),
  ).not.toThrow();
});

const publication = (sequence = 1) => ({
  id: String(sequence).repeat(64),
  sequence,
  manifest: {
    key: `native-executions/manifest-${sequence}.json`,
    versionId: `manifest-version-${sequence}`,
    sha256: String(sequence).repeat(64),
    bytes: 256,
  },
  question: null,
  outcome: 'STOPPED',
  nativeSessionId: 'the-original-native-session',
  filesCount: 3,
});
const checkpoint = (sequence = 1) => ({
  id: 'c'.repeat(64),
  sequence,
  manifest: {
    key: 'native-recovery/v1/protected-test-scope/checkpoint.json',
    versionId: 'checkpoint-version-1',
    sha256: 'c'.repeat(64),
    bytes: 1024,
  },
});
const interaction = (row, sequence = 1) => {
  const id = String(sequence + 2).repeat(64);
  return {
    id,
    sequence,
    nativeSessionId: publication().nativeSessionId,
    publicationId: publication(sequence).id,
    object: {
      key: `${nativePublicationScope(executionIdentity(row)).prefix}interactions/${id}.json`,
      versionId: `interaction-version-${sequence}`,
      sha256: id,
      bytes: 512,
    },
  };
};
const reply = (row) => ({
  interactionId: row.interaction.id,
  contentSha256: row.interactionContentSha256,
  requestId: randomUUID(),
  text: '  $aidlc compose Keep the original request.\r\n',
});
const pendingReply = async ({ capture = true } = {}) => {
  const f = executionFixture();
  await f.start();
  let { row } = await f.store.claim(f.bindingIdentity);
  row = await f.store.advance({
    row,
    patch: {
      status: 'DISPATCHING',
      sourceCommit: 'c'.repeat(40),
      sourceBranch: 'main',
      target: f.target(row),
    },
  });
  row = await f.store.dispatchAttempted({ row });
  row = await f.store.advance({ row, patch: { status: 'RUNNING' } });
  row = await f.store.publish({
    row,
    publication: publication(),
    interaction: interaction(row),
    interactionContentSha256: 'd'.repeat(64),
    ...(capture ? { checkpoint: checkpoint() } : {}),
  });
  row = await f.store.projected({ row });
  const request = reply(row);
  const accepted = await f.store.respond({
    ...f.bindingIdentity,
    actorId: ACTOR,
    request,
  });
  const claimed = await f.store.claim(f.bindingIdentity);
  return { ...f, accepted, request, pending: claimed.row };
};
const rejection = (suffix = 'CONFLICT') => ({ code: `NATIVE_EXECUTION_${suffix}` });

describe('protected native recovery and response admission', () => {
  it('serves cold recovery with admission disabled and preserves the in-flight accepted answer', async () => {
    const f = await pendingReply();
    const required = await f.store.recoveryRequired({ row: f.pending, reason: 'RESTORE_FAILED' });
    const original = structuredClone(f.row());
    const api = createNativeExecutionApi({
      enabled: false,
      store: f.store,
      enqueue: async () => {},
    });
    const result = await api.recover(
      f.prepared,
      {
        requestId: randomUUID(),
        recoveryId: required.recovery.id,
      },
      async () => {},
    );
    expect(result.execution.status).toBe('RECOVERING');
    expect(f.row().configuration).toEqual(original.configuration);
    expect(f.row().response).toEqual(original.response);
    expect(f.row().recoveryCheckpoint).toEqual(original.recoveryCheckpoint);
  });
  it('restores a waiting point while preserving the session, reply, pins and history', async () => {
    const f = await pendingReply();
    const original = f.pending;
    let row = await f.store.beginRecovery({ row: original });
    const recoveryId = row.recovery.id;
    expect(row.status).toBe('RECOVERING');
    expect(row.recovery.phase).toBe('FENCING');
    expect(nativeWriterGeneration(row)).toBe(1);
    row = await f.store.recoveryStopped({ row });
    expect(nativeWriterGeneration(row)).toBe(2);
    expect(row.recovery.phase).toBe('RESTORING');
    row = await f.store.recovered({ row });
    expect(row.status).toBe('DISPATCHING');
    expect(row.lastRecoveryId).toBe(recoveryId);
    expect(row.version).toBeGreaterThan(original.version);
    for (const key of [
      'scope',
      'bindingId',
      'attemptId',
      'runtimeSessionId',
      'epoch',
      'configuration',
      'configurationSha256',
      'target',
      'sourceCommit',
      'sourceBranch',
      'publication',
      'publicationEpoch',
      'interaction',
      'interactionEpoch',
      'interactionContentSha256',
      'response',
      'turnSequence',
      'recoveryCheckpoint',
    ])
      expect(row[key], key).toEqual(original[key]);
    expect(await f.store.response(row, original.interaction.id)).toEqual(f.accepted.response);
    expect(row.dispatch).toBeUndefined();
    row = await f.store.dispatchAttempted({ row });
    expect(row.dispatch).toMatchObject({
      commandId: f.accepted.response.commandId,
      sequence: 2,
      writerGeneration: 2,
    });
    row = await f.store.dispatched({ row });
    expect(row.response.deliveryStatus).toBe('delivered');
    row = await f.store.publish({
      row,
      publication: publication(2),
      interaction: interaction(row, 2),
      interactionContentSha256: 'e'.repeat(64),
    });
    expect(row.status).toBe('AWAITING_USER');
    expect(row.dispatch).toBeUndefined();
    // Never label a newer result with an older checkpoint.
    expect(row.recoveryCheckpoint).toBeUndefined();
    expect(await f.store.response(row, original.interaction.id)).toEqual(f.accepted.response);
  });

  it('journals a dispatch attempt before transport and refuses to replay uncertain work', async () => {
    const f = await pendingReply();
    const row = await f.store.dispatchAttempted({ row: f.pending });
    expect(await f.store.dispatchAttempted({ row })).toEqual(row);
    await expect(f.store.beginRecovery({ row })).rejects.toMatchObject(rejection());
    const stopped = await f.store.recoveryRequired({ row, reason: 'DELIVERY_UNCERTAIN' });
    expect(stopped.recovery.canRecover).toBe(false);
    expect(stopped.response).toEqual(f.pending.response);
    expect(stopped.dispatch).toEqual(row.dispatch);
    await expect(
      f.store.recover({
        ...f.bindingIdentity,
        request: { requestId: randomUUID(), recoveryId: stopped.recovery.id },
      }),
    ).rejects.toMatchObject(rejection());
  });

  it('does not infer a checkpoint from a legacy saved publication', async () => {
    const f = await pendingReply({ capture: false });
    await expect(f.store.beginRecovery({ row: f.pending })).rejects.toMatchObject(rejection());
    const row = await f.store.recoveryRequired({
      row: f.pending,
      reason: 'CHECKPOINT_UNAVAILABLE',
    });
    expect(row.recovery.canRecover).toBe(false);
    expect(row.response.deliveryStatus).toBe('pending');
  });

  it('deduplicates a member recovery retry across tabs without accepting another reply', async () => {
    const f = await pendingReply();
    let row = await f.store.beginRecovery({ row: f.pending });
    row = await f.store.recoveryStopped({ row });
    const firstEpisode = row.recovery.id;
    row = await f.store.recoveryRequired({ row, reason: 'RESTORE_FAILED' });
    expect(row.recovery.id).not.toBe(firstEpisode);
    expect(row.recovery.canRecover).toBe(true);
    const input = {
      ...f.bindingIdentity,
      request: { requestId: randomUUID(), recoveryId: row.recovery.id },
    };
    row = await f.store.recover(input);
    expect(
      await f.store.recover({
        ...input,
        request: { ...input.request, requestId: randomUUID() },
      }),
    ).toEqual(row);
    expect(row.recovery.previousGeneration).toBe(2);
    expect(row.recovery.writerGeneration).toBe(3);
    row = (await f.store.claim(f.bindingIdentity)).row;
    row = await f.store.recoveryStopped({ row });
    row = await f.store.recovered({ row });
    expect(await f.store.recover(input)).toEqual(row);
    const response = await f.store.respond({
      ...f.bindingIdentity,
      actorId: ACTOR,
      request: f.request,
    });
    expect(response.created).toBe(false);
    expect(response.response).toEqual(f.accepted.response);
    expect(response.row.turnSequence).toBe(2);
  });

  it('does not reuse a failed recovery episode after another failure', async () => {
    const f = await pendingReply();
    let row = await f.store.beginRecovery({ row: f.pending });
    row = await f.store.recoveryRequired({ row, reason: 'RESTORE_FAILED' });
    const input = {
      ...f.bindingIdentity,
      request: { requestId: randomUUID(), recoveryId: row.recovery.id },
    };
    await f.store.recover(input);
    row = (await f.store.claim(f.bindingIdentity)).row;
    await f.store.recoveryRequired({ row, reason: 'RESTORE_FAILED' });
    await expect(f.store.recover(input)).rejects.toMatchObject(rejection());
  });

  it.each(['FENCING', 'RESTORING'])('cancellation fences recovery during %s', async (phase) => {
    const f = await pendingReply();
    let row = await f.store.beginRecovery({ row: f.pending });
    if (phase === 'RESTORING') row = await f.store.recoveryStopped({ row });
    const cancelled = await f.store.cancel(f.bindingIdentity);
    expect(cancelled.status).toBe('CANCEL_REQUESTED');
    expect(cancelled.epoch).toBe(2);
    expect(cancelled.publicationEpoch).toBe(1);
    expect(cancelled.recovery.canRecover).toBe(false);
    await expect(f.store.recovered({ row })).rejects.toMatchObject(rejection('CANCELLED'));
    await expect(f.store.recoveryStopped({ row })).rejects.toMatchObject(rejection('CANCELLED'));
    const claimed = (await f.store.claim(f.bindingIdentity)).row;
    expect(
      (
        await f.store.advance({
          row: claimed,
          patch: { status: 'CANCELLED' },
        })
      ).status,
    ).toBe('CANCELLED');
  });

  it('does not let an expired worker finish another owner’s recovery', async () => {
    const f = await pendingReply();
    const row = await f.store.beginRecovery({ row: f.pending });
    f.tick();
    const reclaimed = (await f.store.claim(f.bindingIdentity)).row;
    await expect(f.store.recoveryStopped({ row })).rejects.toMatchObject(rejection('LEASE_LOST'));
    expect((await f.store.recoveryStopped({ row: reclaimed })).writerGeneration).toBe(2);
  });

  it('recognizes its exact committed recovery after acknowledgement loss', async () => {
    const f = await pendingReply();
    let injected = false;
    f.hooks.after = async (command) => {
      if (command instanceof TransactWriteCommand && !injected) {
        injected = true;
        throw new Error('lost transaction acknowledgement');
      }
    };
    const row = await f.store.beginRecovery({ row: f.pending });
    expect(row).toEqual(f.row());
    expect(row.version).toBe(f.pending.version + 1);
  });

  it('exposes only recovery presentation metadata, keeping checkpoints and writer authority private', async () => {
    const f = await pendingReply();
    const row = await f.store.beginRecovery({ row: f.pending });
    const view = nativeExecutionView(row);
    expect(view).toMatchObject({
      status: 'RECOVERING',
      revision: row.version,
      responsePending: true,
      recovery: { id: row.recovery.id, reason: 'SESSION_LOST', canRecover: false },
    });
    for (const field of ['checkpoint', 'writerGeneration', 'FENCING', 'lease', 'native-recovery'])
      expect(JSON.stringify(view)).not.toContain(field);
  });
});
