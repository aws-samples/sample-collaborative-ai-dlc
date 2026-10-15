import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import {
  createNativePublications,
  nativePublicationPath,
  nativePublicationScope,
} from '../native-publication.js';

const identity = {
  projectId: 'project-1',
  executionId: '11111111-1111-4111-8111-111111111111',
  attemptId: '22222222-2222-4222-8222-222222222222',
  epoch: 1,
};
const packageId = `sha256:${'a'.repeat(64)}`;
const input = () => ({
  identity,
  packageId,
  nativeSessionId: 'session-1',
  outcome: 'WAITING_FOR_INPUT',
  repository: { branch: 'develop', commit: 'b'.repeat(40) },
  files: [
    {
      path: 'aidlc/spaces/default/intents/example/questions.md',
      role: 'question',
      content: Buffer.from('# Question\n\nWhat colour?\n\n[Answer]:\n'),
    },
    {
      path: 'src/bird.png',
      role: 'code',
      content: Buffer.from([0, 255, 128, 12]),
    },
  ],
  questionPath: 'aidlc/spaces/default/intents/example/questions.md',
});
const setup = () => {
  const objects = new Map(),
    calls = [];
  let failAt = null;
  const s3 = {
    async send(command) {
      calls.push(command);
      const p = command.input;
      if (failAt === calls.length) throw new Error('storage unavailable');
      if (command.constructor.name === 'PutObjectCommand') {
        const version = `version-${objects.size + 1}`;
        objects.set(`${p.Key}:${version}`, Buffer.from(p.Body));
        return { VersionId: version };
      }
      const bytes = objects.get(`${p.Key}:${p.VersionId}`);
      if (!bytes) throw new Error('missing version');
      return {
        VersionId: p.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes]),
      };
    },
  };
  return {
    store: createNativePublications({
      s3,
      bucket: 'native-results-test',
      accountId: '123456789012',
      now: () => '2026-09-29T12:00:00Z',
    }),
    objects,
    calls,
    fail: (n) => {
      failAt = n;
    },
  };
};

it.each(['upload', 'verify'])(
  'bounds %s inventory work to four and drains failures',
  async (mode) => {
    const f = setup();
    const data = input();
    data.files.push(
      ...Array.from({ length: 10 }, (_, i) => ({
        path: `src/more-${i}.txt`,
        role: 'code',
        content: Buffer.from('saved'),
      })),
    );
    const receipt = await f.store.write(data);
    let entered = 0;
    let active = 0;
    let peak = 0;
    let manifestWrites = 0;
    const releases = [];
    const store = createNativePublications({
      bucket: 'native-results-test',
      accountId: '123456789012',
      s3: {
        async send(command) {
          const p = command.input;
          const write = command.constructor.name === 'PutObjectCommand';
          if (write && p.Key.includes('/manifests/')) manifestWrites++;
          if (p.Key.includes('/files/')) {
            const index = entered++;
            active++;
            peak = Math.max(peak, active);
            try {
              await new Promise((resolve) => releases.push(resolve));
              if (index === 0) throw new Error('injected transfer failure');
            } finally {
              active--;
            }
          }
          if (write) return { VersionId: 'valid-version' };
          const content = f.objects.get(`${p.Key}:${p.VersionId}`);
          return {
            VersionId: p.VersionId,
            ContentLength: content.length,
            Body: Readable.from([content]),
          };
        },
      },
    });
    let settled = false;
    const operation =
      mode === 'upload' ? store.write(data) : store.read(identity, receipt, { verifyFiles: true });
    const rejected = expect(
      operation.finally(() => {
        settled = true;
      }),
    ).rejects.toThrow('injected transfer failure');
    await vi.waitFor(() => expect(entered).toBe(4));
    releases[0]();
    await vi.waitFor(() => expect(active).toBe(3));
    expect(settled).toBe(false);
    releases.slice(1).forEach((release) => release());
    await rejected;
    expect({ entered, active, peak, manifestWrites }).toEqual({
      entered: 4,
      active: 0,
      peak: 4,
      manifestWrites: 0,
    });
  },
);

it('freezes all publication bytes and metadata before concurrent uploads', async () => {
  const f = setup();
  const data = input();
  const receiptPromise = f.store.write(data);
  data.files[1].content.fill(42);
  data.repository.branch = 'changed-after-call';
  const receipt = await receiptPromise;
  const manifest = await f.store.read(identity, receipt, { verifyFiles: true });
  expect(manifest.repository.branch).toBe('develop');
  expect((await f.store.file(identity, manifest, manifest.files[1].id)).bytes).toEqual(
    Buffer.from([0, 255, 128, 12]),
  );
});

it.each([undefined, null, 0])('never commits after a non-Error rejection (%s)', async (failure) => {
  const keys = [];
  const store = createNativePublications({
    bucket: 'native-results-test',
    accountId: '123456789012',
    s3: {
      async send(command) {
        keys.push(command.input.Key);
        throw failure;
      },
    },
  });
  await expect(store.write(input())).rejects.toBe(failure);
  expect(keys.every((key) => key.includes('/files/'))).toBe(true);
});

it.each(['short', 'long', 'interrupted', 'aborted'])(
  'rejects and closes a %s immutable file transfer',
  async (kind) => {
    const f = setup();
    const receipt = await f.store.write(input());
    const manifest = await f.store.read(identity, receipt);
    const controller = new AbortController();
    const bytes = Buffer.from([0, 255, 128, 12]);
    const file = manifest.files[1];
    const stream = new Readable({
      read() {
        if (kind === 'aborted') return;
        this.push(
          kind === 'short'
            ? bytes.subarray(0, 2)
            : kind === 'long'
              ? Buffer.concat([bytes, bytes])
              : bytes,
        );
        if (kind === 'interrupted') this.destroy(new Error('connection lost'));
        else this.push(null);
      },
    });
    const store = createNativePublications({
      bucket: 'native-results-test',
      accountId: '123456789012',
      s3: {
        send: async () => ({
          VersionId: file.object.versionId,
          ContentLength: bytes.length,
          Body: stream,
        }),
      },
    });
    const reading = store.file(identity, manifest, file.id, { signal: controller.signal });
    const rejected = expect(reading).rejects.toThrow();
    if (kind === 'aborted') controller.abort();
    await rejected;
    expect(stream.destroyed).toBe(true);
  },
);

it('validates an immutable source baseline and rejects another pinned commit or nested baseline', async () => {
  const f = setup();
  const sourceInput = { ...input(), outcome: 'STOPPED', nativeSessionId: null, questionPath: null };
  const baseline = await f.store.write(sourceInput);
  const receipt = await f.store.write({
    ...input(),
    sourceBaseline: { epoch: 1, receipt: baseline },
  });
  const manifest = await f.store.read(identity, receipt);
  expect((await f.store.source(identity, manifest, { verifyFiles: true })).receipt.id).toBe(
    baseline.id,
  );
  const foreign = await f.store.write({
    ...sourceInput,
    repository: { ...sourceInput.repository, commit: 'c'.repeat(40) },
  });
  await expect(
    f.store.source(identity, { ...manifest, sourceBaseline: { epoch: 1, receipt: foreign } }),
  ).rejects.toThrow();
  await expect(
    f.store.source(identity, { ...manifest, sourceBaseline: { epoch: 1, receipt } }),
  ).rejects.toThrow();
});

describe('exact native publication', () => {
  it('preserves earlier immutable file versions across sequential native turns', async () => {
    const { store } = setup();
    const first = await store.write(input());
    const laterInput = input();
    laterInput.files[0].content = Buffer.from('# Revised question\n\nWhich style?\n\n[Answer]:\n');
    const second = await store.write({ ...laterInput, sequence: 2 });
    const earlier = await store.read(identity, first, { verifyFiles: true });
    const later = await store.read(identity, second, { verifyFiles: true });
    expect(first.sequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(later.files[0].id).toBe(earlier.files[0].id);
    expect(later.files[0].sha256).not.toBe(earlier.files[0].sha256);
    expect((await store.file(identity, earlier, earlier.files[0].id)).bytes).toEqual(
      input().files[0].content,
    );
  });

  it('permits an empty completed snapshot without fabricating a question or file', async () => {
    const { store } = setup();
    const receipt = await store.write({
      ...input(),
      outcome: 'STOPPED',
      files: [],
      questionPath: null,
    });
    expect(await store.read(identity, receipt, { verifyFiles: true })).toMatchObject({
      sequence: 1,
      outcome: 'STOPPED',
      files: [],
      question: null,
    });
  });

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'rejects invalid publication sequence %s before uploading',
    async (sequence) => {
      const { store, calls } = setup();
      await expect(store.write({ ...input(), sequence })).rejects.toMatchObject({
        code: 'NATIVE_PUBLICATION_INVALID',
      });
      expect(calls).toHaveLength(0);
    },
  );

  it('round-trips exact text/binary bytes through immutable versions and stable file identity', async () => {
    const { store, calls } = setup();
    const receipt = await store.write(input());
    const manifest = await store.read(identity, receipt, { verifyFiles: true });
    expect(manifest.question.path).toBe(input().questionPath);
    for (const [i, descriptor] of manifest.files.entries()) {
      const result = await store.file(identity, manifest, descriptor.id);
      expect(result.bytes).toEqual(input().files[i].content);
    }
    expect(calls.every((c) => c.input.ExpectedBucketOwner === '123456789012')).toBe(true);
    const second = await store.write(input());
    const again = await store.read(identity, second);
    expect(again.files.map((f) => f.id)).toEqual(manifest.files.map((f) => f.id));
    expect(again.files[0].object.versionId).not.toBe(manifest.files[0].object.versionId);
    expect(await store.file(identity, manifest, manifest.files[0].id)).toMatchObject({
      bytes: input().files[0].content,
    });
  });

  it('detects changed file bytes even when length and requested version look valid', async () => {
    const { store, objects } = setup();
    const receipt = await store.write(input());
    const manifest = await store.read(identity, receipt);
    const f = manifest.files[0];
    objects.set(`${f.object.key}:${f.object.versionId}`, Buffer.alloc(f.bytes, 65));
    await expect(store.read(identity, receipt, { verifyFiles: true })).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
  });

  it('rejects cross-attempt manifests before reading storage', async () => {
    const { store, calls } = setup();
    const receipt = await store.write(input());
    const count = calls.length;
    await expect(store.read({ ...identity, epoch: 2 }, receipt)).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
    expect(calls).toHaveLength(count);
  });

  it('detects changed manifest content even with a valid storage response', async () => {
    const { store, objects } = setup();
    const receipt = await store.write(input());
    const key = `${receipt.manifest.key}:${receipt.manifest.versionId}`;
    const altered = Buffer.from(objects.get(key));
    altered[20] ^= 1;
    objects.set(key, altered);
    await expect(store.read(identity, receipt)).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
  });

  it('does not publish a manifest when an earlier file upload fails', async () => {
    const { store, calls, fail } = setup();
    fail(2);
    await expect(store.write(input())).rejects.toThrow('storage unavailable');
    expect(calls.filter((c) => c.input.Key.includes('/manifests/'))).toHaveLength(0);
  });

  it.each([
    '',
    '../secret',
    '/absolute',
    'a/../b',
    'a//b',
    'a\\b',
    'a/\0b',
    '.git/config',
    'repo/.git/config',
    '.codex/auth.json',
    '.native-control/owner',
    'aidlc/spaces/default/intents/x/.aidlc-engine/steering-token-key',
    'aidlc/spaces/default/intents/x/.aidlc-engine/active-directive.lock.gate-mutex',
  ])('rejects unsafe/private path %j before uploading', async (path) => {
    const { store, calls } = setup();
    const data = input();
    data.files[0].path = path;
    await expect(store.write(data)).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
    expect(calls).toHaveLength(0);
  });

  it('refuses duplicate paths or missing question references rather than silently omitting data', async () => {
    for (const data of [
      { ...input(), files: [input().files[0], input().files[0]] },
      { ...input(), questionPath: 'missing.md' },
      { ...input(), questionPath: null },
    ]) {
      const { store, calls } = setup();
      await expect(store.write(data)).rejects.toMatchObject({
        code: 'NATIVE_PUBLICATION_INVALID',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('binds the question checksum and object key to its exact referenced file', async () => {
    const { store, objects } = setup();
    const receipt = await store.write(input());
    const manifest = await store.read(identity, receipt);
    manifest.question.sha256 = 'c'.repeat(64);
    const bytes = Buffer.from(JSON.stringify(manifest));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const key = `${nativePublicationScope(identity).prefix}manifests/${sha256}.json`;
    objects.set(`${key}:tampered`, bytes);
    await expect(
      store.read(identity, {
        ...receipt,
        id: sha256,
        manifest: { key, sha256, bytes: bytes.length, versionId: 'tampered' },
      }),
    ).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
  });

  it('keeps ordinary code and native state paths valid', () => {
    for (const path of [
      'src/game.ts',
      '.gitignore',
      'aidlc/active-space',
      'aidlc/spaces/team/intents/x/.aidlc-engine/active-directive.json',
    ])
      expect(nativePublicationPath(path)).toBe(path);
  });

  it('preserves diagnostic files without claiming a session when the harness stopped before identification', async () => {
    const { store } = setup();
    const receipt = await store.write({
      ...input(),
      outcome: 'STOPPED',
      nativeSessionId: null,
      questionPath: null,
    });
    expect(receipt.nativeSessionId).toBeNull();
    expect((await store.read(identity, receipt, { verifyFiles: true })).outcome).toBe('STOPPED');
    await expect(store.write({ ...input(), nativeSessionId: null })).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
  });
});
