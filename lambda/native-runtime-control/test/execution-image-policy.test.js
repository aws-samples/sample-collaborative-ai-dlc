import { describe, expect, it, vi } from 'vitest';
import { createNativeExecutionApi } from '../execution-api.js';
import { createNativeRuntimeImagePolicy, nativeRuntimeImageKey } from '../runtime-images.js';
import { ACTOR } from './fixtures.js';
import { serialFixture } from './execution-serial-fixtures.js';

// The run pins configuration.image (digest b…). A later deployment ships c….
const NEXT = {
  uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/agentcore@sha256:${'c'.repeat(64)}`,
  digest: `sha256:${'c'.repeat(64)}`,
};
const ENV = { NATIVE_RUNTIME_ACCOUNT_ID: '123456789012', AWS_REGION: 'us-east-1' };

const imageFixture = ({ deployed = NEXT } = {}) => {
  const f = serialFixture();
  const revocations = new Map();
  const reads = [];
  const images = createNativeRuntimeImagePolicy({
    tableName: 'native-bindings',
    env: ENV,
    ddb: {
      send: vi.fn(async (command) => {
        reads.push(command.input.Key);
        const item = revocations.get(command.input.Key.pk);
        return item ? { Item: item } : {};
      }),
    },
  });
  const revoke = (digest) =>
    revocations.set(nativeRuntimeImageKey(digest).pk, {
      ...nativeRuntimeImageKey(digest),
      schemaVersion: 1,
      digest,
      revokedAt: 1_790_000_000_000,
      revokedBy: 'operator',
      reasonCode: 'vulnerable_image',
    });
  const api = createNativeExecutionApi({
    enabled: true,
    store: f.store,
    publications: f.publications,
    interactions: f.interactions,
    enqueue: f.enqueue,
    configure: f.configure,
    authorizeSource: vi.fn(async () => {}),
    images,
    deployment: () => ({ image: structuredClone(deployed) }),
  });
  const awaiting = async () => {
    await api.start(f.prepared, ACTOR, 'start-request', f.recheck);
    await f.ready();
    await f.publish();
    expect(f.row().status).toBe('AWAITING_USER');
  };
  return { ...f, api, images, revoke, reads, awaiting };
};

describe('native API runtime image policy', () => {
  it('keeps a waiting run on its protected older pin after a deployment changes the image', async () => {
    const f = imageFixture();
    await f.awaiting();
    const status = await f.api.status(f.prepared, f.recheck);
    expect(status.execution.imageStatus).toBe('retained');
    const accepted = await f.api.respond(f.prepared, 'member-two', f.replyRequest(), f.recheck);
    expect(accepted.execution.status).toBe('DISPATCHING');
    expect(f.row().configuration.image.digest).toBe(`sha256:${'b'.repeat(64)}`);
  });

  it('blocks renewal and recovery after revocation without hiding committed results', async () => {
    const f = imageFixture();
    await f.awaiting();
    f.revoke(f.row().configuration.image.digest);
    const before = f.row();
    await expect(
      f.api.respond(f.prepared, 'member-two', f.replyRequest(), f.recheck),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_IMAGE_REVOKED' });
    expect(f.row()).toEqual(before);
    expect(f.enqueue).toHaveBeenCalledTimes(1);
    const status = await f.api.status(f.prepared, f.recheck);
    expect(status.execution).toMatchObject({ status: 'AWAITING_USER', imageStatus: 'revoked' });
    const publication = await f.api.publication(f.prepared, f.recheck);
    expect(publication.files.map((file) => file.path)).toEqual(['src/game.js']);
    const interaction = await f.api.interaction(f.prepared, f.recheck);
    expect(interaction.messages[0].text).toMatch(/what should change/);
  });

  it('rejects renewal for a pin outside this deployment repository', async () => {
    const f = imageFixture({
      deployed: {
        uri: `123456789012.dkr.ecr.us-east-1.amazonaws.com/replacement@${NEXT.digest}`,
        digest: NEXT.digest,
      },
    });
    await f.awaiting();
    await expect(
      f.api.respond(f.prepared, 'member-two', f.replyRequest(), f.recheck),
    ).rejects.toMatchObject({ code: 'NATIVE_EXECUTION_IMAGE_UNAPPROVED' });
  });

  it('blocks a new start when the current deployment image is revoked', async () => {
    const f = imageFixture({ deployed: { uri: 'unused', digest: 'unused' } });
    f.revoke(f.configuration.image.digest);
    await expect(f.api.start(f.prepared, ACTOR, 'start-request', f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_IMAGE_REVOKED',
    });
    expect(f.row()).toBeUndefined();
    expect(f.enqueue).not.toHaveBeenCalled();
  });

  it('does not report image status for a terminal run', async () => {
    const f = imageFixture();
    await f.api.start(f.prepared, ACTOR, 'start-request', f.recheck);
    const { row } = await f.store.claim(f.bindingIdentity);
    await f.store.advance({ row, patch: { status: 'FAILED' } });
    const reads = f.reads.length;
    const status = await f.api.status(f.prepared, f.recheck);
    expect(status.execution.imageStatus).toBeUndefined();
    expect(f.reads.length).toBe(reads);
  });
});

describe('native API image policy availability', () => {
  it('reports an unavailable policy on reads while mutations stay fail-closed', async () => {
    const f = imageFixture();
    await f.awaiting();
    const images = {
      decide: vi.fn(async () => {
        throw Object.assign(new Error('throttled'), { code: 'NATIVE_RUNTIME_IMAGE_UNAVAILABLE' });
      }),
      revocation: vi.fn(async () => {
        throw Object.assign(new Error('throttled'), { code: 'NATIVE_RUNTIME_IMAGE_UNAVAILABLE' });
      }),
    };
    const api = createNativeExecutionApi({
      enabled: true,
      store: f.store,
      publications: f.publications,
      interactions: f.interactions,
      enqueue: f.enqueue,
      configure: f.configure,
      authorizeSource: vi.fn(async () => {}),
      images,
      deployment: () => ({ image: structuredClone(NEXT) }),
    });
    const status = await api.status(f.prepared, f.recheck);
    expect(status.execution).toMatchObject({ status: 'AWAITING_USER', imageStatus: 'unavailable' });
    expect((await api.publication(f.prepared, f.recheck)).files).toHaveLength(1);
    expect((await api.interaction(f.prepared, f.recheck)).messages).toHaveLength(1);
    const before = f.row();
    await expect(api.respond(f.prepared, 'member-two', f.replyRequest(), f.recheck)).rejects.toMatchObject(
      { code: 'NATIVE_EXECUTION_UNAVAILABLE' },
    );
    expect(f.row()).toEqual(before);
  });
});
