import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createNativeExecutionFence, nativeExecutionFenceKey } from '../native-execution-fence.js';
import { nativePublicationScope } from '../native-publication.js';

const identity = {
  projectId: 'project-1',
  executionId: '11111111-1111-4111-8111-111111111111',
  bindingId: '22222222-2222-4222-8222-222222222222',
  attemptId: '33333333-3333-4333-8333-333333333333',
  runtimeSessionId: '44444444-4444-4444-8444-444444444444',
  epoch: 1,
};
const make = () => {
  const objects = new Map();
  const calls = [];
  const hooks = {};
  let version = 0;
  const s3 = {
    async send(command) {
      const p = command.input;
      calls.push(command);
      if (command.constructor.name === 'PutObjectCommand') {
        await hooks.beforePut?.(p);
        if (p.IfNoneMatch === '*' && objects.has(p.Key))
          throw Object.assign(new Error('exists'), { name: 'PreconditionFailed' });
        if (p.IfMatch && objects.get(p.Key)?.etag !== p.IfMatch)
          throw Object.assign(new Error('changed'), { name: 'PreconditionFailed' });
        const stored = {
          body: Buffer.from(p.Body),
          version: `version-${++version}`,
          etag: `"etag-${version}"`,
        };
        objects.set(p.Key, stored);
        return { VersionId: stored.version };
      }
      const current = objects.get(p.Key);
      if (!current) throw Object.assign(new Error('absent'), { name: 'NoSuchKey' });
      return {
        VersionId: current.version,
        ETag: current.etag,
        ContentLength: current.body.length,
        Body: Readable.from([current.body]),
      };
    },
  };
  return {
    fence: createNativeExecutionFence({ s3, bucket: 'native-results', accountId: '123456789012' }),
    calls,
    objects,
    hooks,
  };
};

describe('controller-owned native cancellation fence', () => {
  it('admits explicit workspace successors without checkpoints and prevents a later legacy downgrade', async () => {
    const { fence } = make();
    const recoveryId = '55555555-5555-4555-8555-555555555555';
    await fence.ensureActive(identity);
    await fence.suspend(identity, { writerGeneration: 1, recoveryId });
    const input = {
      writerGeneration: 2,
      recoveryId,
      checkpointId: null,
      recoveryMode: 'efs-workspace-v1',
    };
    expect(await fence.activate(identity, input)).toMatchObject({
      schemaVersion: 3,
      state: 'ACTIVE',
      ...input,
    });
    expect(await fence.activate(identity, input)).toMatchObject({ schemaVersion: 3, ...input });
    await fence.suspend(identity, { writerGeneration: 2, recoveryId });
    await expect(
      fence.activate(identity, { writerGeneration: 3, recoveryId, checkpointId: 'a'.repeat(64) }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_FENCE_CONFLICT' });
    await fence.cancel(identity);
    await expect(fence.activate(identity, { ...input, writerGeneration: 3 })).rejects.toMatchObject(
      { code: 'NATIVE_EXECUTION_CANCELLED' },
    );
  });
  it('rejects a corrupt workspace fence carrying an exact checkpoint instead of granting authority', async () => {
    const { fence, objects } = make();
    const recoveryId = '55555555-5555-4555-8555-555555555555';
    await fence.ensureActive(identity);
    await fence.suspend(identity, { writerGeneration: 1, recoveryId });
    await fence.activate(identity, {
      writerGeneration: 2,
      recoveryId,
      checkpointId: null,
      recoveryMode: 'efs-workspace-v1',
    });
    const stored = objects.get(nativeExecutionFenceKey(identity));
    stored.body = Buffer.from(
      JSON.stringify({ ...JSON.parse(stored.body), checkpointId: 'a'.repeat(64) }),
    );
    await expect(fence.read(identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_FENCE_INVALID',
    });
  });
  it('denies delayed starts after cancellation and cannot reopen with a retried ACTIVE write', async () => {
    const { fence } = make();
    await fence.ensureActive(identity);
    expect((await fence.read(identity)).state).toBe('ACTIVE');
    await fence.cancel({ ...identity, epoch: 2 });
    expect((await fence.read(identity)).state).toBe('CANCELLED');
    await expect(fence.ensureActive(identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_CANCELLED',
    });
    expect((await fence.read(identity)).state).toBe('CANCELLED');
  });
  it('can cancel before any dispatch created the ACTIVE fence', async () => {
    const { fence } = make();
    await fence.cancel(identity);
    await expect(fence.ensureActive(identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_CANCELLED',
    });
  });
  it('uses a distinct controller prefix, scopes projects, and ignores cancellation epoch changes in its key', () => {
    expect(nativeExecutionFenceKey(identity)).not.toContain(
      nativePublicationScope(identity).prefix,
    );
    expect(nativeExecutionFenceKey(identity)).toBe(
      nativeExecutionFenceKey({ ...identity, epoch: 2 }),
    );
    expect(nativeExecutionFenceKey(identity)).not.toBe(
      nativeExecutionFenceKey({ ...identity, projectId: 'another-project' }),
    );
  });
  it('requires a present versioned fence and rejects mismatched stored runtime identity', async () => {
    const { fence, objects } = make();
    await expect(fence.read(identity)).rejects.toThrow();
    await fence.ensureActive(identity);
    const stored = objects.get(nativeExecutionFenceKey(identity));
    const changed = JSON.parse(stored.body);
    changed.runtimeSessionId = 'another-session';
    stored.body = Buffer.from(JSON.stringify(changed));
    await expect(fence.read(identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_FENCE_INVALID',
    });
  });
  it('reads the latest version with an expected owner and only creates ACTIVE conditionally', async () => {
    const { fence, calls } = make();
    await fence.ensureActive(identity);
    await fence.cancel(identity);
    for (const call of calls) {
      expect(call.input.ExpectedBucketOwner).toBe('123456789012');
      if (call.constructor.name === 'GetObjectCommand')
        expect(call.input.VersionId).toBeUndefined();
      if (
        call.constructor.name === 'PutObjectCommand' &&
        JSON.parse(call.input.Body).state === 'ACTIVE'
      )
        expect(call.input.IfNoneMatch).toBe('*');
    }
  });
  it('closes an old generation before admitting exactly its stopped-session successor', async () => {
    const { fence, calls } = make();
    const recoveryId = '55555555-5555-4555-8555-555555555555';
    await fence.ensureActive(identity);
    await expect(
      fence.activate(identity, {
        writerGeneration: 2,
        recoveryId,
        checkpointId: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_FENCE_CONFLICT' });
    await fence.suspend(identity, { writerGeneration: 1, recoveryId });
    await expect(fence.ensureActive(identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_FENCE_CONFLICT',
    });
    const input = { writerGeneration: 2, recoveryId, checkpointId: 'a'.repeat(64) };
    const active = await fence.activate(identity, input);
    expect(active).toMatchObject({ schemaVersion: 2, state: 'ACTIVE', ...input });
    expect(await fence.activate(identity, input)).toEqual(active);
    await expect(fence.ensureActive(identity)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_FENCE_CONFLICT',
    });
    await expect(
      fence.suspend(identity, { writerGeneration: 1, recoveryId }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_FENCE_CONFLICT' });
    expect(await fence.ensureActive(identity, { writerGeneration: 2 })).toEqual(active);
    for (const call of calls.filter((c) => c.constructor.name === 'PutObjectCommand').slice(1))
      expect(call.input.IfMatch).toMatch(/^"etag-/);
  });
  it('cancellation wins an activation CAS race without reopening the writer', async () => {
    const { fence, objects, hooks } = make();
    const recoveryId = '55555555-5555-4555-8555-555555555555';
    await fence.ensureActive(identity);
    await fence.suspend(identity, { writerGeneration: 1, recoveryId });
    let version;
    hooks.beforePut = async (input) => {
      if (JSON.parse(input.Body).state === 'ACTIVE') {
        delete hooks.beforePut;
        await fence.cancel({ ...identity, epoch: 2 });
        version = objects.get(nativeExecutionFenceKey(identity)).version;
      }
    };
    await expect(
      fence.activate(identity, {
        writerGeneration: 2,
        recoveryId,
        checkpointId: 'a'.repeat(64),
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_CANCELLED' });
    expect(objects.get(nativeExecutionFenceKey(identity)).version).toBe(version);
    expect((await fence.read(identity)).state).toBe('CANCELLED');
  });
  it('does not create a replacement generation without the old fence or accept malformed generations', async () => {
    const { fence } = make();
    await expect(fence.ensureActive(identity, { writerGeneration: 2 })).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_FENCE_CONFLICT',
    });
    for (const writerGeneration of [0, -1, '1', 1.5, Number.MAX_SAFE_INTEGER + 1])
      await expect(fence.ensureActive(identity, { writerGeneration })).rejects.toMatchObject({
        code: 'NATIVE_EXECUTION_FENCE_INVALID',
      });
  });
});
