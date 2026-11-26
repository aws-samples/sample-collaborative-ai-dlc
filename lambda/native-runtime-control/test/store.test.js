import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { resolveNativeRuntimeBinding } from '../../shared/native-runtime-binding.js';
import { createNativeRuntimeStore, nativeDraftRequest, pinPackageJob } from '../store.js';
import {
  ACTOR,
  DEPLOYMENT,
  IDENTITY,
  IMAGE,
  INTENT,
  MEMBERSHIP,
  OTHER,
  PROJECT,
  TABLE,
  awsError,
  binding,
  candidate,
  createInput,
  job,
  owner,
  pauseOnce,
  receipt,
  request,
  resources,
  setup,
} from './fixtures.js';

describe('native protected draft pins and idempotency', () => {
  it('stores a real immutable draft with a generated binding and pinned provenance, without qualification', async () => {
    const f = setup();
    const created = await f.store.create(createInput());
    expect(created.created).toBe(true);
    expect(created.row).toMatchObject({
      executionId: INTENT,
      projectId: PROJECT,
      status: 'DRAFT',
      schemaVersion: 1,
      executionBackend: 'native',
      isolation: 'execution',
      version: 1,
      fence: 0,
      createdAt: 1000,
      updatedAt: 1000,
      imageUri: IMAGE.uri,
      imageDigest: IMAGE.digest,
      createdBy: ACTOR,
      projectIdentity: MEMBERSHIP.projectIdentity,
      bindingId: expect.stringMatching(/^[\da-f-]{14}4[\da-f-]{21}$/),
      candidate: candidate(),
      archiveReceipt: receipt(),
    });
    expect(created.row).not.toHaveProperty('executionQualified');
    expect(created.row).not.toHaveProperty('runtimeArn');
    expect(await f.store.get(IDENTITY)).toEqual(created.row);
  });

  it('concurrent duplicate requests produce one binding; deployment image changes do not repin it', async () => {
    const f = setup();
    const results = await Promise.all([
      f.store.create(createInput()),
      f.store.create(createInput()),
    ]);
    expect(results.map((result) => result.created).toSorted()).toEqual([false, true]);
    expect(results[0].row).toEqual(results[1].row);
    const changedImage = {
      uri: IMAGE.uri.replaceAll('a'.repeat(64), 'b'.repeat(64)),
      digest: `sha256:${'b'.repeat(64)}`,
    };
    const retry = await f.store.create(createInput({ image: changedImage }));
    expect(retry.row).toEqual(results[0].row);
  });

  it('recovers a lost create acknowledgement by reading the protected row', async () => {
    const f = setup();
    f.hooks.after = (command) => {
      if (command instanceof PutCommand) throw awsError('TimeoutError');
    };
    const result = await f.store.create(createInput());
    expect(result.created).toBe(false);
    expect(result.row).toEqual(f.read());
  });

  it.each([
    ['title only', { title: 'Flappy bird', prompt: '' }],
    ['prompt only', { title: '', prompt: 'Build a small game.' }],
  ])('stores %s without inventing or normalizing either field', async (_label, fields) => {
    const f = setup();
    const original = request(fields);
    const created = await f.store.create(createInput({ request: original }));
    expect(created.row.request).toEqual(original);
    expect((await f.store.get(IDENTITY)).request).toEqual(original);
  });

  it.each([
    ['prompt', { request: request({ prompt: 'Different work' }) }],
    ['harness', { request: request({ harness: 'claude' }) }],
    ['member', { actorId: 'other-member' }],
    ['project lifecycle', { projectIdentity: 'recreated-project' }],
    [
      'receipt',
      {
        archiveReceipt: {
          ...receipt(),
          manifest: { ...receipt().manifest, versionId: 'new-version' },
        },
      },
    ],
  ])('rejects immutable %s changes for an existing id', async (_label, changes) => {
    const f = setup();
    const before = (await f.store.create(createInput())).row;
    await expect(f.store.create(createInput(changes))).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_CONFLICT',
    });
    expect(f.read()).toEqual(before);
  });

  it.each([
    ['caller runtime ARN', { runtimeArn: 'private' }],
    ['extra actor', { actorId: 'admin' }],
    ['non-v4 intent', { intentId: '10000000-0000-7000-8000-000000000001' }],
    ['unsupported harness', { harness: 'other' }],
    ['NUL prompt', { prompt: 'bad\0prompt' }],
    ['both empty', { title: '', prompt: '' }],
    ['both whitespace', { title: ' ', prompt: '\n ' }],
    ['non-string title', { title: null }],
    ['non-string prompt', { prompt: null }],
    ['unbounded title', { title: 'x'.repeat(257) }],
    ['unbounded prompt', { prompt: 'x'.repeat(65537) }],
  ])('rejects invalid request %s', (_label, changes) => {
    expect(() => nativeDraftRequest(request(changes))).toThrow(
      'Invalid native preparation request',
    );
  });

  it.each([
    ['pending job', { state: 'RUNNING' }],
    ['wrong project', { projectId: 'other' }],
    ['wrong job', { jobId: OTHER }],
    ['changed revision', { bindingRevision: OTHER }],
    ['wrong candidate scope', { candidate: candidate({ projectId: 'other' }) }],
    [
      'wrong requested release',
      { requestedRelease: 'v2.8.0', candidate: candidate({ requestedRelease: 'v2.8.0' }) },
    ],
    [
      'wrong receipt',
      { archiveReceipt: { ...receipt(), materializationId: `sha256:${'0'.repeat(64)}` } },
    ],
  ])('rejects package %s', (_label, changes) => {
    expect(() =>
      pinPackageJob(job(changes), { projectId: PROJECT, request: request(), binding: binding() }),
    ).toThrow('A matching completed package import is required');
  });

  it('pins a completed package without copying credential references or treating import as signature qualification', () => {
    expect(
      pinPackageJob(job(), { projectId: PROJECT, request: request(), binding: binding() }),
    ).toEqual({ candidate: candidate(), archiveReceipt: receipt() });
    expect(() =>
      pinPackageJob(job(), {
        projectId: PROJECT,
        request: request(),
        binding: binding({ repository: 'attacker/fork' }),
      }),
    ).toThrow();
  });

  it('fails closed on malformed deployment, mismatched image digest and corrupted protected rows', async () => {
    const f = setup();
    expect(() =>
      createNativeRuntimeStore({
        ddb: f.ddb,
        tableName: TABLE,
        deployment: { ...DEPLOYMENT, region: '.*' },
      }),
    ).toThrow('Native preparation is unavailable');
    await expect(
      f.store.create(createInput({ image: { ...IMAGE, digest: `sha256:${'b'.repeat(64)}` } })),
    ).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_INVALID' });
    await f.store.create(createInput());
    f.write({ ...f.read(), request: request({ prompt: 'tampered' }) });
    await expect(f.store.get(IDENTITY)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_INVALID',
    });
  });
});

describe('native preparation CAS and worker fencing', () => {
  it('concurrent prepare commits a single PREPARING generation; repeat prepare does not reset ownership', async () => {
    const f = setup();
    const draft = (await f.store.create(createInput())).row;
    const rows = await Promise.all([f.store.prepare(IDENTITY), f.store.prepare(IDENTITY)]);
    expect(rows[0]).toEqual(rows[1]);
    expect(rows[0]).toMatchObject({ status: 'PREPARING', version: 2, bindingId: draft.bindingId });
    const claim = await f.store.claim({ ...IDENTITY, bindingId: draft.bindingId });
    expect(await f.store.prepare(IDENTITY)).toEqual(claim.row);
    expect(await f.store.claim({ ...IDENTITY, bindingId: draft.bindingId })).toEqual({
      kind: 'busy',
      row: claim.row,
    });
  });

  it('recovers a lost mutation acknowledgement only for the exact written version', async () => {
    const f = setup();
    await f.store.create(createInput());
    f.hooks.after = (command) => {
      if (command instanceof PutCommand) throw awsError('TimeoutError');
    };
    const result = await f.store.prepare(IDENTITY);
    expect(result).toEqual(f.read());
    expect(result.status).toBe('PREPARING');
  });

  it('expired takeover retains resources and fences the prior owner out', async () => {
    const f = setup();
    const first = await f.claimed();
    const advanced = await f.store.advance({
      ...owner(first),
      patch: { accessPointArn: resources(first).accessPointArn },
    });
    f.setTime(1100);
    const second = await f.store.claim({ ...IDENTITY, bindingId: first.bindingId });
    expect(second.kind).toBe('claimed');
    expect(second.row).toMatchObject({ fence: 2, accessPointArn: resources(first).accessPointArn });
    expect(second.row.leaseToken).not.toBe(first.leaseToken);
    for (const method of ['advance', 'release', 'fail', 'ready']) {
      await expect(
        f.store[method]({
          ...owner(advanced),
          patch: {},
          resources: resources(first),
          code: 'native_provisioning_failed',
        }),
      ).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_LEASE_LOST' });
    }
    expect(f.read()).toEqual(second.row);
  });

  it('releases only ownership and permits immediate fenced takeover with the same resources', async () => {
    const f = setup({ leaseMs: 120000 });
    const first = await f.claimed();
    const advanced = await f.store.advance({
      ...owner(first),
      patch: resources(first),
    });
    const released = await f.store.release(owner(advanced));
    const expected = { ...advanced, version: advanced.version + 1 };
    delete expected.leaseToken;
    delete expected.leaseExpiresAt;
    expect(released).toEqual(expected);
    expect(await f.store.prepare(IDENTITY)).toEqual(released);

    const next = await f.store.claim({ ...IDENTITY, bindingId: released.bindingId });
    expect(next.kind).toBe('claimed');
    expect(next.row.fence).toBe(advanced.fence + 1);
    expect(next.row.leaseToken).not.toBe(advanced.leaseToken);
    expect(next.row.runtimeArn).toBe(advanced.runtimeArn);
    expect(next.row.accessPointArn).toBe(advanced.accessPointArn);
    for (const method of ['advance', 'release', 'ready', 'fail']) {
      await expect(
        f.store[method]({ ...owner(advanced), patch: {}, resources: {} }),
      ).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_LEASE_LOST' });
    }
    expect(f.read()).toEqual(next.row);
  });

  it('recovers a lost release acknowledgement only when the entire released row matches', async () => {
    const f = setup();
    const first = await f.claimed();
    f.hooks.after = (command) => {
      if (command instanceof PutCommand) throw awsError('TimeoutError');
    };
    const released = await f.store.release(owner(first));
    expect(released).toEqual(f.read());
    expect(released.status).toBe('PREPARING');
    expect(released).not.toHaveProperty('leaseToken');
  });

  it('does not report a release as successful after a newer owner has already claimed it', async () => {
    const f = setup();
    const first = await f.claimed();
    let next;
    f.hooks.after = async (command) => {
      if (!(command instanceof PutCommand)) return;
      f.hooks.after = undefined;
      next = await f.store.claim({ ...IDENTITY, bindingId: first.bindingId });
      throw awsError('TimeoutError');
    };
    await expect(f.store.release(owner(first))).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_UNAVAILABLE',
    });
    expect(next.kind).toBe('claimed');
    expect(f.read()).toEqual(next.row);
  });

  it('does not clear a new owner when release races with takeover after its ownership read', async () => {
    const f = setup();
    const first = await f.claimed();
    const gate = pauseOnce(f, 'before', (command) => command instanceof PutCommand);
    const release = f.store.release(owner(first));
    const rejected = expect(release).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_CONFLICT',
    });
    await gate.started;
    f.setTime(first.leaseExpiresAt);
    const next = await f.store.claim({ ...IDENTITY, bindingId: first.bindingId });
    gate.resume();
    await rejected;
    expect(f.read()).toEqual(next.row);
  });

  it('retains ownership on an uncommitted release failure and rejects expiry or repeat release', async () => {
    const f = setup();
    const first = await f.claimed();
    f.hooks.before = (command) => {
      if (command instanceof PutCommand) throw awsError('ServiceUnavailableException');
    };
    await expect(f.store.release(owner(first))).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_UNAVAILABLE',
    });
    expect(f.read()).toEqual(first);
    f.hooks.before = undefined;
    f.setTime(first.leaseExpiresAt);
    await expect(f.store.release(owner(first))).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_LEASE_LOST',
    });
    const next = await f.store.claim({ ...IDENTITY, bindingId: first.bindingId });
    const released = await f.store.release(owner(next.row));
    await expect(f.store.release(owner(next.row))).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_LEASE_LOST',
    });
    expect(f.read()).toEqual(released);
  });

  it('rejects a stale write that passed the initial ownership read before takeover', async () => {
    const f = setup();
    const first = await f.claimed();
    const gate = pauseOnce(f, 'before', (command) => command instanceof PutCommand);
    const staleWrite = f.store.advance({
      ...owner(first),
      patch: { accessPointArn: resources(first).accessPointArn },
    });
    const rejected = expect(staleWrite).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_CONFLICT',
    });
    await gate.started;
    f.setTime(1100);
    const second = await f.store.claim({ ...IDENTITY, bindingId: first.bindingId });
    gate.resume();
    await rejected;
    expect(f.read()).toEqual(second.row);
  });

  it('does not let a delayed successful response authorize writes after a newer owner takes over', async () => {
    const f = setup();
    const first = await f.claimed();
    const gate = pauseOnce(f, 'after', (command) => command instanceof PutCommand);
    const write = f.store.advance({ ...owner(first), patch: {} });
    await gate.started;
    f.setTime(1100);
    const second = await f.store.claim({ ...IDENTITY, bindingId: first.bindingId });
    f.hooks.after = undefined;
    // The old successful response is delayed, not lost; its returned version is
    // stale and therefore cannot authorize another mutation.
    gate.resume();
    const staleResult = await write;
    await expect(f.store.advance({ ...owner(staleResult), patch: {} })).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_LEASE_LOST',
    });
    expect(f.read()).toEqual(second.row);
  });

  it('requires the latest version even within one live lease and preserves immutable resource identity', async () => {
    const f = setup();
    const first = await f.claimed();
    const advanced = await f.store.advance({
      ...owner(first),
      patch: { accessPointArn: resources(first).accessPointArn },
    });
    await expect(f.store.advance({ ...owner(first), patch: {} })).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_LEASE_LOST',
    });
    await expect(
      f.store.advance({
        ...owner(advanced),
        patch: { accessPointArn: resources(first).accessPointArn.replace('fsap-123', 'fsap-456') },
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PREPARATION_CONFLICT' });
    expect(f.read()).toEqual(advanced);
  });

  it.each([
    [
      'other account',
      (r) => ({ executionRoleArn: r.executionRoleArn.replace('123456789012', '999999999999') }),
    ],
    ['other root', () => ({ rootDirectory: '/runs/somebody-else' })],
    ['other mount', () => ({ mountPath: '/mnt/workspace' })],
    ['other filesystem', () => ({ fileSystemId: 'fs-00000000000000000' })],
    ['arbitrary progress', () => ({ verified: true })],
    ['status injection', () => ({ status: 'READY' })],
    ['binding injection', () => ({ bindingId: OTHER })],
    ['runtime id mismatch', (r) => ({ runtimeArn: r.runtimeArn, runtimeId: r.runtimeId + 'X' })],
  ])('rejects %s from worker progress', async (_label, patch) => {
    const f = setup();
    const claimed = await f.claimed();
    await expect(
      f.store.advance({ ...owner(claimed), patch: patch(resources(claimed)) }),
    ).rejects.toThrow();
    expect(f.read()).toEqual(claimed);
  });

  it('publishes READY only with the full dispatch tuple and no active lease', async () => {
    const f = setup();
    const claimed = await f.claimed();
    await expect(f.store.ready({ ...owner(claimed), resources: {} })).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_INVALID',
    });
    const ready = await f.store.ready({ ...owner(claimed), resources: resources(claimed) });
    expect(ready.status).toBe('READY');
    expect(ready).not.toHaveProperty('leaseToken');
    expect(ready).not.toHaveProperty('leaseExpiresAt');
    expect(
      await resolveNativeRuntimeBinding({
        ddb: f.ddb,
        tableName: TABLE,
        ...IDENTITY,
        deployment: DEPLOYMENT,
      }),
    ).toMatchObject({
      bindingId: ready.bindingId,
      target: { agentRuntimeArn: ready.runtimeArn, qualifier: ready.runtimeEndpoint },
    });
    expect(await f.store.prepare(IDENTITY)).toEqual(ready);
    expect(await f.store.claim({ ...IDENTITY, bindingId: ready.bindingId })).toEqual({
      kind: 'terminal',
      row: ready,
    });
  });

  it('stores a safe failure code and requires explicit prepare to retry with the same resources and a new fence', async () => {
    const f = setup();
    const initial = await f.claimed();
    const claimed = await f.store.advance({
      ...owner(initial),
      patch: { accessPointArn: resources(initial).accessPointArn },
    });
    const failed = await f.store.fail({ ...owner(claimed), code: 'secret exception ARN token' });
    expect(failed).toMatchObject({ status: 'FAILED', failureCode: 'native_provisioning_failed' });
    expect(failed).not.toHaveProperty('leaseToken');
    expect(await f.store.claim({ ...IDENTITY, bindingId: failed.bindingId })).toEqual({
      kind: 'terminal',
      row: failed,
    });
    const retried = await f.store.prepare(IDENTITY);
    expect(retried).toMatchObject({
      status: 'PREPARING',
      bindingId: failed.bindingId,
      imageUri: failed.imageUri,
      accessPointArn: failed.accessPointArn,
      fence: failed.fence,
      version: failed.version + 1,
    });
    expect(retried).not.toHaveProperty('failureCode');
    const next = await f.store.claim({ ...IDENTITY, bindingId: failed.bindingId });
    expect(next.row.fence).toBe(failed.fence + 1);
    await expect(f.store.advance({ ...owner(claimed), patch: {} })).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_LEASE_LOST',
    });
  });

  it('does not claim a draft, an absent run, or a different binding generation', async () => {
    const f = setup();
    expect(await f.store.claim({ ...IDENTITY, bindingId: OTHER })).toEqual({ kind: 'missing' });
    const draft = (await f.store.create(createInput())).row;
    await expect(f.store.claim({ ...IDENTITY, bindingId: draft.bindingId })).rejects.toThrow();
    await f.store.prepare(IDENTITY);
    await expect(f.store.claim({ ...IDENTITY, bindingId: OTHER })).rejects.toThrow();
  });

  it('redacts storage failures and fails closed on malformed reads', async () => {
    const f = setup();
    f.hooks.before = () => {
      throw awsError('AccessDenied');
    };
    await expect(f.store.get(IDENTITY)).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_UNAVAILABLE',
      message: 'Native preparation is unavailable',
    });
    const malformed = createNativeRuntimeStore({
      ddb: { send: async () => null },
      tableName: TABLE,
      deployment: DEPLOYMENT,
    });
    await expect(malformed.get(IDENTITY)).rejects.toThrow('Native preparation is unavailable');
  });

  it('expires ownership before a new write without a model execution timeout', async () => {
    const f = setup();
    const claimed = await f.claimed();
    f.setTime(claimed.leaseExpiresAt);
    await expect(f.store.advance({ ...owner(claimed), patch: {} })).rejects.toMatchObject({
      code: 'NATIVE_PREPARATION_LEASE_LOST',
    });
    expect(f.read().status).toBe('PREPARING');
    expect(
      f.ddb.send.mock.calls.every(
        ([command]) => command instanceof GetCommand || command instanceof PutCommand,
      ),
    ).toBe(true);
  });
});
