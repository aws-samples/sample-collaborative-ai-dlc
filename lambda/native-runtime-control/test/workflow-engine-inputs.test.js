import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  encodeNativeEngineFiles,
  nativeEngineFiles,
  nativeEngineFileDigest,
  nativeEngineObjectPrefix,
  nativeEngineAuthoredPath,
} from '../../shared/native-workflow-protocol.js';
import { createNativeEngineObjects } from '../../shared/native-workflow-objects.js';

const identity = {
  projectId: 'project',
  executionId: randomUUID(),
  bindingId: randomUUID(),
  attemptId: randomUUID(),
  epoch: 1,
};
const files = (...paths) =>
  encodeNativeEngineFiles(
    paths.map((path) => ({
      path,
      content: Buffer.from(`contents of ${path}`),
    })),
  );
describe('protected engine input boundary', () => {
  it('binds exact bytes, sorts consistently, and rejects directories shadowed in either order', () => {
    const value = nativeEngineFiles(files('src/é.js', 'src/a.js'));
    expect(value.map((file) => file.path)).toEqual(['src/a.js', 'src/é.js']);
    expect(nativeEngineFileDigest(value)).toBe(nativeEngineFileDigest([...value].reverse()));
    for (const paths of [
      ['src', 'src/a'],
      ['src/a', 'src'],
      ['src/a', 'src/a'],
    ])
      expect(() => nativeEngineFiles(files(...paths))).toThrow('NATIVE_ENGINE_INPUT_INVALID');
    for (const path of ['../authority', '/etc/passwd', 'a//b', 'a/../b'])
      expect(() => nativeEngineFiles(files(path))).toThrow('NATIVE_ENGINE_INPUT_INVALID');
    const bad = files('src/app.js');
    bad[0].content = Buffer.from('replacement').toString('base64');
    expect(() => nativeEngineFiles(bad)).toThrow('NATIVE_ENGINE_INPUT_INVALID');
  });

  it('never imports a coding workspace ledger, engine code or private review as authority', () => {
    const paths = [
      '.codex/tools/aidlc-lib.ts',
      '.aidlc/tools/aidlc-state.ts',
      'aidlc/spaces/default/intents/work/aidlc-state.md',
      'aidlc/spaces/default/intents/work/audit/log.md',
      'aidlc/spaces/default/intents/work/reviews/quality.md',
      'aidlc/spaces/default/memory/org.md',
      '.git/config',
      '.native-control/signing-key',
    ];
    for (const path of paths) expect(nativeEngineAuthoredPath(path, paths)).toBe(false);
    const artifact = 'aidlc/spaces/default/intents/work/inception/requirements.md';
    expect(nativeEngineAuthoredPath(artifact, [artifact])).toBe(true);
    expect(nativeEngineAuthoredPath(artifact)).toBe(false);
    // This is import authority, not the NE-10 member visibility policy.
    expect(nativeEngineAuthoredPath('.env')).toBe(true);
    expect(nativeEngineAuthoredPath('src/main.js')).toBe(true);
  });
});

describe('versioned private engine objects', () => {
  const fixture = () => {
    const versions = new Map();
    const requests = [];
    let replaceRead;
    const s3 = {
      async send(command) {
        requests.push(command.input);
        if (command.constructor.name === 'PutObjectCommand') {
          const VersionId = randomUUID();
          versions.set(VersionId, {
            key: command.input.Key,
            body: Buffer.from(command.input.Body),
          });
          return { VersionId };
        }
        const version = versions.get(command.input.VersionId);
        expect(version.key).toBe(command.input.Key);
        return {
          VersionId: command.input.VersionId,
          ContentLength: version.body.length,
          Body: Readable.from([replaceRead?.(version.body) ?? version.body]),
        };
      },
    };
    return {
      requests,
      corrupt: (transform) => {
        replaceRead = transform;
      },
      objects: createNativeEngineObjects({
        s3,
        bucket: 'private-engine',
        accountId: '123456789012',
      }),
    };
  };
  it('reads back an exact immutable version before returning its receipt', async () => {
    const f = fixture();
    const receipt = await f.objects.write(identity, randomUUID(), 'snapshot', { state: 'private' });
    expect(receipt.key.startsWith(nativeEngineObjectPrefix(identity))).toBe(true);
    expect(await f.objects.read(identity, receipt)).toEqual({ state: 'private' });
    expect(f.requests[0]).toMatchObject({
      ContentType: 'application/gzip',
      ServerSideEncryption: 'AES256',
      ExpectedBucketOwner: '123456789012',
    });
    expect(f.requests[0]).not.toHaveProperty('ContentEncoding');
    expect(f.requests[1].VersionId).toBe(receipt.versionId);
    const count = f.requests.length;
    await expect(
      f.objects.read({ ...identity, bindingId: randomUUID() }, receipt),
    ).rejects.toMatchObject({ code: 'NATIVE_ENGINE_OBJECT_INVALID' });
    await expect(f.objects.read(identity, { ...receipt, versionId: 'null' })).rejects.toMatchObject(
      { code: 'NATIVE_ENGINE_OBJECT_INVALID' },
    );
    expect(f.requests).toHaveLength(count);
  });
  it('rejects truncated, extended or different bytes even when metadata matches', async () => {
    const f = fixture();
    const receipt = await f.objects.write(identity, randomUUID(), 'snapshot', { state: 'private' });
    for (const transform of [
      (body) => body.subarray(1),
      (body) => Buffer.concat([body, Buffer.from('x')]),
      (body) => Buffer.alloc(body.length),
    ]) {
      f.corrupt(transform);
      await expect(f.objects.read(identity, receipt)).rejects.toMatchObject({
        code: 'NATIVE_ENGINE_OBJECT_INVALID',
      });
    }
  });
});
