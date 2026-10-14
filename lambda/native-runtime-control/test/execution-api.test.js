import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describe, expect, it, vi } from 'vitest';
import { createNativeExecutionApi } from '../execution-api.js';
import {
  createNativePublications,
  nativeFileId,
  nativePublicationScope,
} from '../../shared/native-publication.js';
import { executionFixture } from './execution-fixtures.js';
import { ACTOR, OTHER, TABLE } from './fixtures.js';
import { canonicalJson } from '../../shared/workflow-checkpoint.js';

const hash = (value) => createHash('sha256').update(value).digest('hex');
const QUESTION_PATH = 'aidlc/spaces/default/intents/pipe-visualization/questions.md';
const SOURCE = { branch: 'release/stable', commit: 'c'.repeat(40) };
const publicationIdentity = (row) => ({
  ...row.scope,
  attemptId: row.attemptId,
  epoch: row.publicationEpoch ?? row.epoch,
});
const sampleFiles = () => [
  {
    path: QUESTION_PATH,
    role: 'question',
    content: Buffer.from('# Pipe visualization\r\n\r\nWelche Farbe? 🐦\r\n\r\n[Answer]:  \r\n'),
  },
  { path: 'src/game.ts', role: 'code', content: Buffer.from('const bird = "🐦";\n') },
  { path: 'src/pipe.png', role: 'code', content: Buffer.from([137, 80, 78, 71, 0, 255, 128, 12]) },
  { path: 'data/nul.txt', role: 'artifact', content: Buffer.from('alpha\0omega', 'utf8') },
  { path: 'empty.txt', role: 'artifact', content: Buffer.alloc(0) },
  {
    path: 'notes/bom.md',
    role: 'artifact',
    content: Buffer.from('\ufeff# Preserve BOM\n', 'utf8'),
  },
];

// Own immutable-version S3 fake. It performs actual byte storage/streaming;
// none of the publication validator or execution store is mocked.
const memoryS3 = ({ bucket, accountId }) => {
  const objects = new Map();
  const calls = [];
  const hooks = {};
  let version = 0;
  const key = (path, id) => `${path}\0${id}`;
  const s3 = {
    send: vi.fn(async (command) => {
      calls.push(command);
      const input = command.input;
      expect(input.Bucket).toBe(bucket);
      expect(input.ExpectedBucketOwner).toBe(accountId);
      if (command instanceof PutObjectCommand) {
        const bytes = Buffer.from(input.Body);
        expect(input.ChecksumSHA256).toBe(createHash('sha256').update(bytes).digest('base64'));
        const VersionId = `test-version-${++version}`;
        objects.set(key(input.Key, VersionId), bytes);
        return { VersionId };
      }
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(typeof input.VersionId).toBe('string');
      await hooks.beforeRead?.(command);
      const bytes = objects.get(key(input.Key, input.VersionId));
      if (!bytes) throw new Error('Requested immutable version does not exist');
      const reply = {
        VersionId: input.VersionId,
        ContentLength: bytes.length,
        Body: Readable.from([bytes.subarray(0, 2), bytes.subarray(2, 7), bytes.subarray(7)]),
      };
      await hooks.reply?.(command, reply);
      return reply;
    }),
  };
  return {
    s3,
    calls,
    hooks,
    overwrite(pointer, bytes) {
      objects.set(key(pointer.key, pointer.versionId), Buffer.from(bytes));
    },
  };
};

const fixture = () => {
  const f = executionFixture();
  const authorityCalls = [];
  const originalSend = f.ddb.send.bind(f.ddb);
  f.ddb.send = async (command) => {
    authorityCalls.push(command);
    return originalSend(command);
  };
  const storage = memoryS3({
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
  });
  const publications = createNativePublications({
    s3: storage.s3,
    bucket: f.configuration.publicationBucket,
    accountId: f.configuration.accountId,
    now: () => '2026-09-29T12:00:00.000Z',
  });
  const authorization = { member: true, source: true };
  const recheck = vi.fn(async (draft) => {
    expect(draft.projectId).toBe(f.prepared.projectId);
    expect(draft.projectIdentity).toBe(f.prepared.projectIdentity);
    if (!authorization.member) {
      throw Object.assign(new Error('Native intent access denied'), {
        code: 'NATIVE_PREPARATION_FORBIDDEN',
      });
    }
  });
  const configure = vi.fn(async () => structuredClone(f.configuration));
  const authorizeSource = vi.fn(async () => {
    if (!authorization.source) {
      throw Object.assign(new Error('Source binding was revoked'), {
        code: 'NATIVE_EXECUTION_CONFIG_SOURCE_CONTROL_CHANGED',
      });
    }
  });
  const enqueue = vi.fn().mockResolvedValue(undefined);
  const makeApi = (enabled = true) =>
    createNativeExecutionApi({
      enabled,
      store: f.store,
      configure,
      publications,
      enqueue,
      authorizeSource,
    });
  const api = makeApi();
  const dispatch = async () => {
    await f.start();
    const { row } = await f.store.claim(f.bindingIdentity);
    return f.store.advance({
      row,
      patch: {
        status: 'DISPATCHING',
        target: f.target(row),
        sourceBranch: SOURCE.branch,
        sourceCommit: SOURCE.commit,
      },
    });
  };
  const stage = (row, files = sampleFiles(), overrides = {}) =>
    publications.write({
      identity: publicationIdentity(row),
      packageId: f.configuration.packageId,
      nativeSessionId: 'native-session-one',
      outcome: 'WAITING_FOR_INPUT',
      repository: SOURCE,
      files,
      questionPath: QUESTION_PATH,
      ...overrides,
    });
  const publish = async ({ files = sampleFiles(), ...overrides } = {}) => {
    const row = await dispatch();
    const receipt = await stage(row, files, overrides);
    const committed = await f.store.publish({ row, publication: receipt });
    const manifest = await publications.read(publicationIdentity(committed), receipt);
    return { row: committed, receipt, manifest, files };
  };
  return {
    ...f,
    storage,
    publications,
    authorization,
    recheck,
    configure,
    authorizeSource,
    enqueue,
    api,
    makeApi,
    dispatch,
    stage,
    publish,
    authorityCalls,
  };
};
const writes = (f) => f.authorityCalls.filter((command) => command instanceof TransactWriteCommand);
const getCalls = (f) => f.storage.calls.filter((command) => command instanceof GetObjectCommand);
const deny = { code: 'NATIVE_PREPARATION_FORBIDDEN' };
const conflict = { code: 'NATIVE_EXECUTION_CONFLICT' };
const missing = { code: 'NATIVE_PUBLICATION_NOT_FOUND' };
const pause = (f, predicate) => {
  const entered = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let paused = false;
  f.storage.hooks.beforeRead = async (command) => {
    if (paused || !predicate(command)) return;
    paused = true;
    entered.resolve();
    await resume.promise;
  };
  return { entered: entered.promise, resume: resume.resolve };
};

describe('native execution API with real protected storage', () => {
  it('returns a narrow absent/status/start DTO and never exposes authority or credentials', async () => {
    const f = fixture();
    expect(await f.api.status(f.prepared, f.recheck)).toEqual({
      executionAvailable: true,
      admissionEnabled: true,
      execution: null,
    });
    const result = await f.api.start(f.prepared, ACTOR, 'api-start-one', f.recheck);
    const row = f.row();
    expect(result).toEqual({
      executionAvailable: true,
      execution: {
        status: 'REQUESTED',
        revision: row.version,
        recovery: null,
        attemptId: row.attemptId,
        epoch: 1,
        startedAt: new Date(row.startedAt).toISOString(),
        updatedAt: new Date(row.updatedAt).toISOString(),
        model: f.configuration.model,
        credentialSource: f.configuration.credentialBinding.source,
        imageDigest: f.configuration.image.digest,
        repository: {
          provider: 'github',
          repository: 'JWThewes/flappy-bird',
          branch: null,
          commit: null,
        },
        publicationId: null,
        publicationSequence: null,
        stopStatus: { state: 'unconfirmed', confirmedAt: null },
        projectionStatus: null,
        sequence: 1,
        interactionId: null,
        responsePending: false,
      },
    });
    expect(f.configure).toHaveBeenCalledWith({ draft: f.prepared, actorId: ACTOR });
    expect(f.enqueue).toHaveBeenCalledWith(f.identity);
    expect(row.startedBy).toBe(ACTOR);
    expect(row.requestId).toBe('api-start-one');
    const json = JSON.stringify(result);
    for (const hidden of [
      'credentialBinding',
      'runtimeSessionId',
      'configurationSha256',
      'requestFingerprint',
      'packageBucket',
      'publicationBucket',
      'leaseToken',
      'rolePolicySha256',
      f.prepared.runtimeArn,
      f.prepared.request.prompt,
    ])
      expect(json).not.toContain(hidden);
  });

  it('preserves starter/configuration on a second member start and only re-enqueues the same execution', async () => {
    const f = fixture();
    const first = await f.api.start(f.prepared, ACTOR, 'first', f.recheck);
    const before = f.row();
    f.configuration.model = 'openai.changed-after-start';
    f.configuration.credentialBinding = { provider: 'bedrock', source: 'platform' };
    f.configure.mockRejectedValue(new Error('Current settings are unavailable'));
    const transactions = writes(f).length;
    const second = await f.api.start(f.prepared, 'second-member', 'second', f.recheck);
    expect(second).toEqual(first);
    expect((await f.api.status(f.prepared, f.recheck)).execution).toEqual(first.execution);
    expect(f.row()).toEqual(before);
    expect(writes(f)).toHaveLength(transactions);
    expect(f.configure).toHaveBeenCalledTimes(1);
    expect(f.enqueue.mock.calls).toEqual([[f.identity], [f.identity]]);
  });

  it('does not start when disabled, but still permits cancellation of an existing execution', async () => {
    const f = fixture();
    const disabled = f.makeApi(false);
    await expect(disabled.start(f.prepared, ACTOR, 'disabled', f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_EXECUTION_DISABLED',
    });
    expect(f.configure).not.toHaveBeenCalled();
    expect(f.row()).toBeUndefined();
    await f.api.start(f.prepared, ACTOR, 'enabled', f.recheck);
    expect(await disabled.cancel(f.prepared, f.recheck)).toMatchObject({
      executionAvailable: true,
      execution: { status: 'CANCEL_REQUESTED', epoch: 2 },
    });
  });

  it('admits only one configuration when concurrent Starts observe different model settings', async () => {
    const bothConfigured = Promise.withResolvers();
    const f = fixture();
    let calls = 0;
    f.configure.mockImplementation(async () => {
      const model = ++calls === 1 ? 'openai.before-edit' : 'openai.after-edit';
      if (calls === 2) bothConfigured.resolve();
      await bothConfigured.promise;
      return { ...structuredClone(f.configuration), model };
    });
    const results = await Promise.allSettled([
      f.api.start(f.prepared, ACTOR, 'before-edit', f.recheck),
      f.api.start(f.prepared, ACTOR, 'after-edit', f.recheck),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected').reason.code).toBe(
      'NATIVE_EXECUTION_CONFLICT',
    );
    const winner = results.find((result) => result.status === 'fulfilled').value.execution;
    expect((await f.api.status(f.prepared, f.recheck)).execution).toEqual(winner);
    expect(f.row().configuration.model).toBe(winner.model);
    expect(f.row().configurationSha256).toBe(hash(canonicalJson(f.row().configuration)));
  });

  it('cancels idempotently, fences the epoch and never creates another execution on start retry', async () => {
    const f = fixture();
    await f.api.start(f.prepared, ACTOR, 'first', f.recheck);
    const first = await f.api.cancel(f.prepared, f.recheck);
    const row = f.row();
    expect(row).toMatchObject({
      cancelRequested: true,
      status: 'CANCEL_REQUESTED',
      epoch: 2,
      stop: { state: 'PENDING' },
    });
    expect(await f.api.cancel(f.prepared, f.recheck)).toEqual(first);
    expect(await f.api.start(f.prepared, 'second-member', 'retry', f.recheck)).toMatchObject({
      execution: first.execution,
    });
    expect(f.row()).toEqual(row);
    expect(f.configure).toHaveBeenCalledTimes(1);
  });

  it.each(['membership', 'source'])(
    'does not commit Start when %s is revoked during configuration',
    async (kind) => {
      const f = fixture();
      f.configure.mockImplementation(async () => {
        f.authorization[kind === 'membership' ? 'member' : 'source'] = false;
        return structuredClone(f.configuration);
      });
      await expect(f.api.start(f.prepared, ACTOR, 'race', f.recheck)).rejects.toHaveProperty(
        'code',
      );
      expect(f.row()).toBeUndefined();
      expect(writes(f)).toHaveLength(0);
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it.each(['status', 'start', 'cancel'])(
    'denies %s after membership revocation without a mutation',
    async (operation) => {
      const f = fixture();
      await f.start();
      const before = f.row();
      const count = writes(f).length;
      f.authorization.member = false;
      const call =
        operation === 'start'
          ? f.api.start(f.prepared, ACTOR, 'denied', f.recheck)
          : f.api[operation](f.prepared, f.recheck);
      await expect(call).rejects.toMatchObject(deny);
      expect(f.row()).toEqual(before);
      expect(writes(f)).toHaveLength(count);
      expect(f.enqueue).not.toHaveBeenCalled();
    },
  );

  it('rejects a different preparation generation instead of reading or cancelling its execution', async () => {
    const f = fixture();
    await f.start();
    const changed = { ...f.prepared, bindingId: '90000000-0000-4000-8000-000000000001' };
    const before = f.row();
    await expect(f.api.status(changed, f.recheck)).rejects.toMatchObject(conflict);
    await expect(f.api.cancel(changed, f.recheck)).rejects.toMatchObject(conflict);
    expect(f.row()).toEqual(before);
  });
});

describe('committed native files and exact content', () => {
  it('does not expose uploaded bytes until the protected store commits their receipt', async () => {
    const f = fixture();
    const row = await f.dispatch();
    const receipt = await f.stage(row);
    const fileId = nativeFileId(publicationIdentity(row), QUESTION_PATH);
    const before = getCalls(f).length;
    await expect(f.api.publication(f.prepared, f.recheck)).rejects.toMatchObject(missing);
    await expect(f.api.file(f.prepared, fileId, f.recheck)).rejects.toMatchObject(missing);
    await expect(f.api.graph(f.prepared, f.recheck)).rejects.toMatchObject(missing);
    expect(getCalls(f)).toHaveLength(before);
    await f.store.publish({ row, publication: receipt });
    expect((await f.api.publication(f.prepared, f.recheck)).id).toBe(receipt.id);
  });

  it('keeps the committed version when later uncommitted uploads reuse the same file keys', async () => {
    const f = fixture();
    const p = await f.publish();
    const staged = await f.stage(p.row);
    expect(staged.id).not.toBe(p.receipt.id);
    const result = await f.api.publication(f.prepared, f.recheck);
    expect(result.id).toBe(p.receipt.id);
    const question = p.manifest.files.find((file) => file.path === QUESTION_PATH);
    const file = await f.api.file(f.prepared, question.id, f.recheck);
    expect(file.publicationId).toBe(p.receipt.id);
    expect(getCalls(f).at(-1).input.VersionId).toBe(question.object.versionId);
  });

  it('returns manifest metadata without object keys, versions, buckets or runtime scope', async () => {
    const f = fixture();
    const p = await f.publish();
    const result = await f.api.publication(f.prepared, f.recheck);
    expect(result).toEqual({
      id: p.receipt.id,
      sequence: 1,
      createdAt: '2026-09-29T12:00:00.000Z',
      files: p.manifest.files.map(({ object: _object, ...file }) => file),
      question: p.manifest.question,
      projectionStatus: 'pending',
    });
    for (const hidden of ['versionId', '"object"', '"scope"', 'manifest', 'Bucket', 'runtimeArn']) {
      expect(JSON.stringify(result)).not.toContain(hidden);
    }
  });

  it.each(sampleFiles().map((file) => [file.path]))(
    'round-trips exact bytes for %s',
    async (path) => {
      const f = fixture();
      const p = await f.publish();
      const source = p.files.find((file) => file.path === path);
      const descriptor = p.manifest.files.find((file) => file.path === path);
      const result = await f.api.file(f.prepared, descriptor.id, f.recheck);
      expect(result).toMatchObject({
        id: descriptor.id,
        path,
        bytes: source.content.length,
        sha256: hash(source.content),
        publicationId: p.receipt.id,
      });
      const decoded =
        result.encoding === 'base64'
          ? Buffer.from(result.content, 'base64')
          : Buffer.from(result.content, 'utf8');
      expect(decoded).toEqual(source.content);
      expect(hash(decoded)).toBe(result.sha256);
      if (path.endsWith('.png') || path === 'data/nul.txt') expect(result.encoding).toBe('base64');
      else expect(result.encoding).toBe('utf8');
      expect(getCalls(f).at(-1).input).toMatchObject({
        Key: descriptor.object.key,
        VersionId: descriptor.object.versionId,
      });
    },
  );

  it.each(['not-a-file', '../.git/config', OTHER])(
    'rejects unknown file id %s without fetching file content',
    async (id) => {
      const f = fixture();
      await f.publish();
      const before = getCalls(f).length;
      await expect(f.api.file(f.prepared, id, f.recheck)).rejects.toMatchObject(missing);
      expect(
        getCalls(f)
          .slice(before)
          .every((command) => command.input.Key.includes('/manifests/')),
      ).toBe(true);
    },
  );

  it('rejects files over the inline limit without reading or truncating them', async () => {
    const f = fixture();
    const p = await f.publish({
      files: [
        ...sampleFiles(),
        { path: 'large.bin', role: 'artifact', content: Buffer.alloc(3 * 1024 * 1024 + 1) },
      ],
    });
    const file = p.manifest.files.find((item) => item.path === 'large.bin');
    const before = getCalls(f).length;
    await expect(f.api.file(f.prepared, file.id, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_FILE_TOO_LARGE',
    });
    expect(
      getCalls(f)
        .slice(before)
        .every((command) => command.input.Key.includes('/manifests/')),
    ).toBe(true);
    expect((await f.api.publication(f.prepared, f.recheck)).files).toContainEqual(
      expect.objectContaining({ id: file.id, bytes: file.bytes }),
    );
  });

  it('accepts the exact inline limit without changing content', async () => {
    const f = fixture();
    const content = Buffer.alloc(3 * 1024 * 1024, 65);
    const p = await f.publish({
      files: [sampleFiles()[0], { path: 'limit.txt', role: 'artifact', content }],
    });
    const file = p.manifest.files.find((item) => item.path === 'limit.txt');
    const result = await f.api.file(f.prepared, file.id, f.recheck);
    expect(result.encoding).toBe('utf8');
    expect(Buffer.byteLength(result.content)).toBe(content.length);
    expect(hash(Buffer.from(result.content))).toBe(hash(content));
  });

  it('rejects substituted same-length file bytes under the original object version', async () => {
    const f = fixture();
    const p = await f.publish();
    const file = p.manifest.files[0];
    f.storage.overwrite(file.object, Buffer.alloc(file.bytes, 65));
    await expect(f.api.file(f.prepared, file.id, f.recheck)).rejects.toMatchObject({
      code: 'NATIVE_PUBLICATION_INVALID',
    });
  });

  it.each(['publication', 'graph', 'file'])(
    'rejects a committed manifest for another package on %s',
    async (operation) => {
      const f = fixture();
      const p = await f.publish({ packageId: `sha256:${'f'.repeat(64)}` });
      const call =
        operation === 'file'
          ? f.api.file(f.prepared, p.manifest.files[0].id, f.recheck)
          : f.api[operation](f.prepared, f.recheck);
      await expect(call).rejects.toMatchObject({ code: 'NATIVE_PUBLICATION_INVALID' });
    },
  );
});

describe('native publication reads across cancellation and membership changes', () => {
  it('retains publicationEpoch after cancellation and reads historical committed bytes in that epoch', async () => {
    const f = fixture();
    const p = await f.publish();
    await f.api.cancel(f.prepared, f.recheck);
    expect(f.row()).toMatchObject({ epoch: 2, publicationEpoch: 1, publication: p.receipt });
    const before = getCalls(f).length;
    expect((await f.api.publication(f.prepared, f.recheck)).id).toBe(p.receipt.id);
    const result = await f.api.file(f.prepared, p.manifest.files[0].id, f.recheck);
    expect(Buffer.from(result.content)).toEqual(p.files[0].content);
    expect((await f.api.graph(f.prepared, f.recheck)).publicationId).toBe(p.receipt.id);
    const originalPrefix = nativePublicationScope(publicationIdentity(p.row)).prefix;
    expect(
      getCalls(f)
        .slice(before)
        .every((command) => command.input.Key.startsWith(originalPrefix)),
    ).toBe(true);
  });

  it.each(['manifest', 'file'])(
    'rejects cancellation during a %s read, then permits an explicit fresh historical read',
    async (phase) => {
      const f = fixture();
      const p = await f.publish();
      const gate = pause(f, (command) =>
        command.input.Key.includes(phase === 'manifest' ? '/manifests/' : '/files/'),
      );
      const read =
        phase === 'manifest'
          ? f.api.publication(f.prepared, f.recheck)
          : f.api.file(f.prepared, p.manifest.files[0].id, f.recheck);
      const rejected = expect(read).rejects.toMatchObject(conflict);
      await gate.entered;
      await f.store.cancel(f.bindingIdentity);
      gate.resume();
      await rejected;
      expect((await f.api.publication(f.prepared, f.recheck)).id).toBe(p.receipt.id);
    },
  );

  it.each(['publication', 'graph', 'file'])(
    'suppresses %s when membership is revoked during storage reads',
    async (operation) => {
      const f = fixture();
      const p = await f.publish();
      const gate = pause(f, (command) =>
        command.input.Key.includes(operation === 'file' ? '/files/' : '/manifests/'),
      );
      const promise =
        operation === 'file'
          ? f.api.file(f.prepared, p.manifest.files[0].id, f.recheck)
          : f.api[operation](f.prepared, f.recheck);
      const rejected = expect(promise).rejects.toMatchObject(deny);
      await gate.entered;
      f.authorization.member = false;
      gate.resume();
      await rejected;
      expect(f.row()).toEqual(p.row);
    },
  );

  it('uses only native protected authority keys and never writes platform META during the API lifecycle', async () => {
    const f = fixture();
    await f.api.start(f.prepared, ACTOR, 'first', f.recheck);
    const { row } = await f.store.claim(f.bindingIdentity);
    const active = await f.store.advance({
      row,
      patch: {
        status: 'DISPATCHING',
        target: f.target(row),
        sourceBranch: SOURCE.branch,
        sourceCommit: SOURCE.commit,
      },
    });
    const receipt = await f.stage(active);
    await f.store.publish({ row: active, publication: receipt });
    await f.api.publication(f.prepared, f.recheck);
    await f.api.graph(f.prepared, f.recheck);
    await f.api.cancel(f.prepared, f.recheck);
    await f.api.status(f.prepared, f.recheck);
    expect(writes(f).length).toBeGreaterThan(0);
    for (const command of f.authorityCalls) {
      const operations =
        command instanceof GetCommand
          ? [command.input]
          : command.input.TransactItems.map((item) => item.Put ?? item.ConditionCheck);
      for (const operation of operations) {
        expect(operation.TableName).toBe(TABLE);
        const key = operation.Key ?? operation.Item;
        expect(key.pk).toMatch(/^NATIVE#[a-f0-9]{64}$/);
        expect(key.sk).toMatch(/^(RUNTIME|EXECUTION|(?:PUBLICATION|EVENT)#[0-9]{16})$/);
        expect(key.sk).not.toBe('META');
      }
    }
  });
});
