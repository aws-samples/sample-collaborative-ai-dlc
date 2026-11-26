import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Readable } from 'node:stream';
import { createHash } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';
import { createNativePackageStorageProbe, handler } from '../storage-probe.js';

const RUN = 'd716f208-5402-4d2f-961c-6242347cc728';
const PREFIX = `native-packages/v1/__qualification__/${RUN}/`;
const SOURCE = `${PREFIX}source.txt`;
const BODY = Buffer.from('native-package-storage-probe/v1\n');
const CONFLICT = Buffer.from('native-package-storage-probe/v1/conflict\n');
const bodyEvidence = (body) => ({
  byteLength: body.length,
  sha256: createHash('sha256').update(body).digest('hex'),
});
const VERSION = 'known-version.1';
const ETAG = '"0123456789abcdef0123456789abcdef"';
const CONFIG = {
  enabled: true,
  bucket: 'native-package-probe-tests',
  expectedBucketOwner: '123456789012',
  runId: RUN,
};
const EVENT = { schemaVersion: 1, runId: RUN };
const CASES = [
  'initial_create',
  'initial_current_get',
  'initial_version_get',
  'identical_conditional_put',
  'conflicting_conditional_put',
  'missing_condition_put',
  'wrong_condition_put',
  'if_match_overwrite',
  'unconditional_overwrite',
  'copy_without_condition',
  'copy_destination_condition',
  'create_multipart_upload',
  'create_multipart_upload_condition',
  'adjacent_prefix_put',
  'delete_current',
  'delete_version',
  'delete_objects_current',
  'delete_objects_version',
  'final_current_get',
  'final_version_get',
];
const metadata = (status = 200) => ({
  httpStatusCode: status,
  requestId: 'safe-request-id',
  attempts: 1,
});
const s3Error = (name, status) =>
  Object.assign(new Error('PRIVATE diagnostic: credentials, headers, body'), {
    name,
    $metadata: { ...metadata(), httpStatusCode: status },
  });
const objectResponse = (overrides = {}) => ({
  $metadata: metadata(),
  VersionId: VERSION,
  ServerSideEncryption: 'AES256',
  ETag: ETAG,
  ContentLength: BODY.length,
  Body: Readable.from([BODY]),
  ...overrides,
});

const setup = ({ override, reused = false, config = {} } = {}) => {
  let exists = reused;
  const bodies = [];
  const normal = (command) => {
    if (command instanceof GetObjectCommand) {
      const response = objectResponse();
      bodies.push(response.Body);
      return response;
    }
    if (
      command instanceof PutObjectCommand &&
      command.input.Key === SOURCE &&
      command.input.IfNoneMatch === '*'
    ) {
      if (exists) throw s3Error('PreconditionFailed', 412);
      exists = true;
      return { $metadata: metadata(), VersionId: VERSION, ServerSideEncryption: 'AES256' };
    }
    throw s3Error('AccessDenied', 403);
  };
  const s3 = {
    send: vi.fn(async (command, options) =>
      override
        ? override(command, s3.send.mock.calls.length - 1, () => normal(command), options)
        : normal(command),
    ),
  };
  return {
    s3,
    bodies,
    probe: createNativePackageStorageProbe({ ...CONFIG, s3, ...config }),
  };
};
const batchDenied = (command) => ({
  $metadata: metadata(),
  Errors: command.input.Delete.Objects.map((entry) => ({
    ...entry,
    Code: 'AccessDenied',
    Message: 'PRIVATE batch error message',
  })),
});

beforeEach(() => {
  vi.stubEnv('NATIVE_PACKAGE_STORAGE_PROBE_ENABLED', 'true');
  vi.stubEnv('NATIVE_PACKAGE_JOBS_ENABLED', 'false');
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('storage probe input and opt-in boundary', () => {
  it.each([
    null,
    undefined,
    [],
    'event',
    1,
    {},
    { ...EVENT, schemaVersion: '1' },
    { ...EVENT, schemaVersion: 2 },
    { ...EVENT, runId: '9f26aa6d-656b-49a6-9a44-748867017542' },
    { ...EVENT, Records: [] },
    { Records: [{ body: JSON.stringify(EVENT) }] },
    { ...EVENT, requestContext: {} },
    { body: JSON.stringify(EVENT) },
    ...['bucket', 'key', 'body', 'version', 'tests', 'nonce', 'prefix', 'ChecksumSHA256'].map(
      (field) => ({
        ...EVENT,
        [field]: 'injected',
      }),
    ),
    Object.assign(Object.create(null), EVENT),
    { ...EVENT, [Symbol('extra')]: true },
  ])('rejects non-exact invocation without I/O: %j', async (event) => {
    const h = setup();
    expect(await h.probe(event)).toMatchObject({
      code: 'INVALID_REQUEST',
      qualification: 'unverified',
      completedCases: [],
    });
    expect(h.s3.send).not.toHaveBeenCalled();
  });

  it.each([
    { enabled: false },
    { enabled: 'true' },
    { bucket: '' },
    { bucket: 'a/../bucket' },
    { bucket: 'invalid..bucket' },
    { bucket: 'invalid.-bucket' },
    { bucket: 'invalid-.bucket' },
    { bucket: 'invalid-bucket\n' },
    { bucket: '127.0.0.1' },
    { bucket: undefined },
    { expectedBucketOwner: '123' },
    { expectedBucketOwner: '123456789012\n' },
    { expectedBucketOwner: 123456789012 },
    { runId: 'not-a-uuid' },
    { runId: `${RUN}\n` },
    { runId: `${RUN}/../escape` },
    { runId: RUN.toUpperCase() },
    { runId: RUN.replace('-4d2f-', '-5d2f-') },
    { runId: RUN.replace('-4d2f-', '-7d2f-') },
    { runId: '00000000-0000-0000-0000-000000000000' },
    { s3: null },
  ])('rejects invalid/disabled host configuration without I/O: %j', async (config) => {
    const h = setup({ config });
    expect((await h.probe(EVENT)).code).toMatch(/^(DISABLED|INVALID_CONFIG)$/);
    expect(h.s3.send).not.toHaveBeenCalled();
  });

  it('defaults enabled to false', async () => {
    const h = setup({ config: { enabled: undefined } });
    expect((await h.probe(EVENT)).code).toBe('DISABLED');
    expect(h.s3.send).not.toHaveBeenCalled();
  });

  it.each([
    [undefined, 'false'],
    ['false', 'false'],
    ['TRUE', 'false'],
    ['true', undefined],
    ['true', 'true'],
    ['true', 'False'],
    ['true', '0'],
  ])('requires exact environment gates (%s, %s)', async (enabled, jobs) => {
    vi.stubEnv('NATIVE_PACKAGE_STORAGE_PROBE_ENABLED', enabled);
    vi.stubEnv('NATIVE_PACKAGE_JOBS_ENABLED', jobs);
    const h = setup();
    expect((await h.probe(EVENT)).code).toBe('DISABLED');
    expect(h.s3.send).not.toHaveBeenCalled();
  });

  it('wires the handler from the fixed environment with one attempt, and rechecks gates before I/O', async () => {
    vi.stubEnv('NATIVE_PACKAGES_BUCKET', CONFIG.bucket);
    vi.stubEnv('NATIVE_PACKAGES_EXPECTED_BUCKET_OWNER', CONFIG.expectedBucketOwner);
    vi.stubEnv('NATIVE_PACKAGE_STORAGE_PROBE_RUN_ID', RUN);
    const h = setup();
    const clients = new Set();
    const send = vi
      .spyOn(S3Client.prototype, 'send')
      .mockImplementation(function (command, options) {
        clients.add(this);
        return h.s3.send(command, options);
      });
    expect((await handler({ ...EVENT, key: 'injected' })).code).toBe('INVALID_REQUEST');
    expect(send).not.toHaveBeenCalled();
    expect((await handler(EVENT)).code).toBe('CHECKS_COMPLETED');
    expect(clients.size).toBe(1);
    expect(await [...clients][0].config.maxAttempts()).toBe(1);
    vi.stubEnv('NATIVE_PACKAGE_JOBS_ENABLED', 'true');
    expect((await handler(EVENT)).code).toBe('DISABLED');
    expect(send).toHaveBeenCalledTimes(CASES.length);
  });
});

describe('bounded sequential storage evidence', () => {
  it('runs the fixed sequence with exact owners, conditions, versions and synthetic targets', async () => {
    const h = setup();
    const result = await h.probe(EVENT);
    expect(result).toMatchObject({
      code: 'CHECKS_COMPLETED',
      qualification: 'unverified',
      runId: RUN,
      runtime: { arch: process.arch, nodeVersion: process.version },
      plannedSyntheticPrefix: PREFIX,
      generatedSyntheticPrefix: `${PREFIX}${result.nonce}/`,
      syntheticBodies: { source: bodyEvidence(BODY), conflict: bodyEvidence(CONFLICT) },
      maxCases: 20,
    });
    expect(result.nonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
    expect(result.completedCases.map((entry) => entry.case)).toEqual(CASES);
    expect(result.completedCases.every((entry) => entry.status === 'PASS')).toBe(true);
    const commands = h.s3.send.mock.calls.map(([command, options]) => {
      expect(options.abortSignal).toBeInstanceOf(AbortSignal);
      expect(command.input).toMatchObject({
        Bucket: CONFIG.bucket,
        ExpectedBucketOwner: CONFIG.expectedBucketOwner,
      });
      return command;
    });
    expect(commands.map((command) => command.constructor.name)).toEqual([
      'PutObjectCommand',
      'GetObjectCommand',
      'GetObjectCommand',
      ...Array(6).fill('PutObjectCommand'),
      'CopyObjectCommand',
      'CopyObjectCommand',
      'CreateMultipartUploadCommand',
      'CreateMultipartUploadCommand',
      'PutObjectCommand',
      'DeleteObjectCommand',
      'DeleteObjectCommand',
      'DeleteObjectsCommand',
      'DeleteObjectsCommand',
      'GetObjectCommand',
      'GetObjectCommand',
    ]);
    expect(commands[0].input).toMatchObject({
      Key: SOURCE,
      IfNoneMatch: '*',
      Body: BODY,
      ServerSideEncryption: 'AES256',
      ChecksumSHA256: createHash('sha256').update(BODY).digest('base64'),
    });
    expect(commands[3].input.Body.equals(BODY)).toBe(true);
    expect(commands[4].input.Body.equals(BODY)).toBe(false);
    expect(commands[5].input).not.toHaveProperty('IfNoneMatch');
    expect(commands[6].input.IfNoneMatch).toBe('"wrong"');
    expect(commands[7].input.IfMatch).toBe(ETAG);
    expect(commands[8].input).toMatchObject({ Key: SOURCE, Body: CONFLICT });
    expect(commands[8].input).not.toHaveProperty('IfNoneMatch');
    expect(commands[8].input).not.toHaveProperty('IfMatch');
    const freshKeys = [5, 6, 9, 10, 11, 12].map((index) => commands[index].input.Key);
    expect(new Set(freshKeys).size).toBe(6);
    expect(
      freshKeys.every((key) => key.startsWith(result.generatedSyntheticPrefix) && key !== SOURCE),
    ).toBe(true);
    expect(commands[13].input).toMatchObject({
      Key: `native-packages/__qualification__/${RUN}/outside-prefix.txt`,
      IfNoneMatch: '*',
    });
    for (const index of [9, 10]) {
      expect(commands[index].input).toMatchObject({
        CopySource: `${CONFIG.bucket}/${SOURCE}?versionId=${VERSION}`,
        ExpectedSourceBucketOwner: CONFIG.expectedBucketOwner,
        MetadataDirective: 'REPLACE',
        Metadata: {},
        TaggingDirective: 'REPLACE',
        Tagging: '',
        AnnotationDirective: 'EXCLUDE',
      });
      expect(commands[index].input).not.toHaveProperty('CopySourceIfNoneMatch');
    }
    expect(commands[9].input).not.toHaveProperty('IfNoneMatch');
    expect(commands[10].input.IfNoneMatch).toBe('*');
    for (const index of [1, 14, 18]) expect(commands[index].input).not.toHaveProperty('VersionId');
    for (const index of [2, 15, 19]) expect(commands[index].input.VersionId).toBe(VERSION);
    expect(commands[16].input.Delete).toEqual({ Objects: [{ Key: SOURCE }], Quiet: false });
    expect(commands[17].input.Delete).toEqual({
      Objects: [{ Key: SOURCE, VersionId: VERSION }],
      Quiet: false,
    });
    for (const [index, command] of commands.entries()) {
      const evidence = result.completedCases[index];
      expect(evidence.key).toBe(command.input.Key ?? SOURCE);
      expect(evidence.timestamp).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
      expect(evidence.attempts).toBe(1);
      if (command instanceof PutObjectCommand) {
        expect(command.input.ChecksumSHA256).toBe(
          createHash('sha256').update(command.input.Body).digest('base64'),
        );
        expect(evidence.syntheticBody).toEqual(bodyEvidence(command.input.Body));
      }
    }
    expect(commands[4].input.ChecksumSHA256).not.toBe(commands[3].input.ChecksumSHA256);
    expect(result.completedCases[3].observedErrorName).toBe('PreconditionFailed');
    expect(result.completedCases[8].observedErrorName).toBe('AccessDenied');
    expect(result.completedCases[0]).not.toHaveProperty('observedErrorName');
    expect(h.bodies.every((body) => body.destroyed)).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([
    ['AccessDenied', 400],
    ['Forbidden', 403],
    ['PreconditionFailed', 412],
    ['AccessDenied', undefined],
    [undefined, 403],
    ['AccessDenied', '403'],
  ])('does not count %s/%s as a 403 AccessDenied', async (name, status) => {
    const h = setup({
      override: (_, index, next) => {
        if (index === 5) throw s3Error(name, status);
        return next();
      },
    });
    const result = await h.probe(EVENT);
    expect(result.code).toBe('STOPPED');
    expect(result.completedCases.at(-1)).toMatchObject({
      case: 'missing_condition_put',
      status: 'INCONCLUSIVE',
    });
    expect(h.s3.send).toHaveBeenCalledTimes(6);
  });

  it.each([
    ['AccessDenied', 403],
    ['Other', 412],
    ['PreconditionFailed', 403],
  ])(
    'requires exact PreconditionFailed/412 for conditional overwrite (%s/%s)',
    async (name, status) => {
      const h = setup({
        override: (_, index, next) => {
          if (index === 3) throw s3Error(name, status);
          return next();
        },
      });
      expect((await h.probe(EVENT)).code).toBe('STOPPED');
      expect(h.s3.send).toHaveBeenCalledTimes(4);
    },
  );

  it('continues after the fixed wrong-condition PUT returns NotImplemented/501 without denial proof', async () => {
    const h = setup({
      override: (command, index, next) => {
        if (index === 6) {
          expect(command).toBeInstanceOf(PutObjectCommand);
          expect(command.input.IfNoneMatch).toBe('"wrong"');
          throw s3Error('NotImplemented', 501);
        }
        return next();
      },
    });
    const result = await h.probe(EVENT);
    expect(result).toMatchObject({ code: 'INCONCLUSIVE', qualification: 'unverified' });
    expect(result.completedCases.map((entry) => entry.case)).toEqual(CASES);
    expect(result.completedCases[6]).toMatchObject({
      case: 'wrong_condition_put',
      status: 'INCONCLUSIVE',
      code: 'CONDITION_NOT_IMPLEMENTED',
      observedErrorName: 'NotImplemented',
      httpStatusCode: 501,
      requestId: 'safe-request-id',
      attempts: 1,
      key: `${result.generatedSyntheticPrefix}wrong-condition.txt`,
      syntheticBody: bodyEvidence(BODY),
    });
    expect(
      result.completedCases
        .filter((_, index) => index !== 6)
        .every((entry) => entry.status === 'PASS'),
    ).toBe(true);
    expect(h.s3.send).toHaveBeenCalledTimes(CASES.length);
    const finalReads = h.s3.send.mock.calls.slice(-2).map(([command]) => {
      expect(command).toBeInstanceOf(GetObjectCommand);
      expect(command.input.Key).toBe(SOURCE);
      return command.input.VersionId;
    });
    expect(finalReads).toEqual([undefined, VERSION]);
  });

  it.each([
    [5, 'NotImplemented', 501],
    [7, 'NotImplemented', 501],
    [11, 'NotImplemented', 501],
    [6, 'InternalError', 501],
    [6, 'notimplemented', 501],
    [6, 'NotImplemented', 400],
    [6, 'NotImplemented', '501'],
  ])('stops for nonmatching condition errors at case %i (%s/%s)', async (index, name, status) => {
    const h = setup({
      override: (_, currentIndex, next) => {
        if (currentIndex === index) throw s3Error(name, status);
        return next();
      },
    });
    const result = await h.probe(EVENT);
    expect(result).toMatchObject({ code: 'STOPPED', qualification: 'unverified' });
    expect(result.completedCases.at(-1)).toMatchObject({
      case: CASES[index],
      status: 'INCONCLUSIVE',
      code: 'UNEXPECTED_S3_ERROR',
    });
    expect(h.s3.send).toHaveBeenCalledTimes(index + 1);
  });

  it.each([400, 501])('copy HTTP %s is inconclusive, never denial proof', async (status) => {
    const h = setup({
      override: (command, _, next) => {
        if (command instanceof CopyObjectCommand)
          throw s3Error(status === 501 ? 'NotImplemented' : 'InvalidArgument', status);
        return next();
      },
    });
    const result = await h.probe(EVENT);
    expect(result.code).toBe('INCONCLUSIVE');
    expect(result.qualification).toBe('unverified');
    expect(
      result.completedCases
        .filter((entry) => entry.case.startsWith('copy_'))
        .map((entry) => entry.status),
    ).toEqual(['INCONCLUSIVE', 'INCONCLUSIVE']);
    expect(result.completedCases.at(-1).case).toBe('final_version_get');
  });

  it.each([400, 501])(
    'signed-header multipart HTTP %s is inconclusive, never denial proof',
    async (status) => {
      const name = status === 400 ? 'InvalidRequest' : 'NotImplemented';
      const h = setup({
        override: (_, index, next) => {
          if (index === 12) throw s3Error(name, status);
          return next();
        },
      });
      const result = await h.probe(EVENT);
      expect(result.code).toBe('INCONCLUSIVE');
      expect(result.completedCases[12]).toMatchObject({
        case: 'create_multipart_upload_condition',
        status: 'INCONCLUSIVE',
        code: 'MULTIPART_CONDITION_REJECTED',
        observedErrorName: name,
        httpStatusCode: status,
        attempts: 1,
        key: `${result.generatedSyntheticPrefix}multipart-conditional.txt`,
      });
      expect(result.completedCases[11].status).toBe('PASS');
      expect(result.completedCases.at(-1).case).toBe('final_version_get');
      expect(result.qualification).toBe('unverified');
      expect(h.s3.send).toHaveBeenCalledTimes(CASES.length);
    },
  );

  it.each([3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])(
    'stops immediately on an unexpected successful mutation at case %i',
    async (unexpectedIndex) => {
      const h = setup({
        override: (_, index, next) =>
          index === unexpectedIndex ? { $metadata: metadata() } : next(),
      });
      const result = await h.probe(EVENT);
      expect(result.code).toBe('STOPPED');
      expect(result.completedCases.at(-1)).toMatchObject({
        case: CASES[unexpectedIndex],
        status: 'FAIL',
        code: 'UNEXPECTED_MUTATION_RESPONSE',
      });
      expect(h.s3.send).toHaveBeenCalledTimes(unexpectedIndex + 1);
    },
  );

  it.each([11, 12])(
    'returns only the synthetic multipart key and UploadId for operator cleanup at case %i',
    async (unexpectedIndex) => {
      const h = setup({
        override: (_, index, next) =>
          index === unexpectedIndex
            ? { $metadata: metadata(), UploadId: 'synthetic-upload+id/=', Secret: 'PRIVATE' }
            : next(),
      });
      const result = await h.probe(EVENT);
      expect(result.operatorCleanup).toEqual({
        key: h.s3.send.mock.calls[unexpectedIndex][0].input.Key,
        UploadId: 'synthetic-upload+id/=',
      });
      expect(result.operatorCleanup.key.startsWith(PREFIX)).toBe(true);
      expect(h.s3.send).toHaveBeenCalledTimes(unexpectedIndex + 1);
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );

  it.each([18, 19])('checks final read %i for unchanged version', async (indexToChange) => {
    const h = setup({
      override: (_, index, next) =>
        index === indexToChange ? objectResponse({ VersionId: 'unexpected-new-version' }) : next(),
    });
    const result = await h.probe(EVENT);
    expect(result.completedCases.at(-1)).toMatchObject({
      case: CASES[indexToChange],
      status: 'FAIL',
    });
    expect(result.code).toBe('STOPPED');
    expect(h.s3.send).toHaveBeenCalledTimes(indexToChange + 1);
  });

  it.each([18, 19])('checks final read %i for unchanged bytes', async (indexToChange) => {
    const h = setup({
      override: (_, index, next) =>
        index === indexToChange
          ? objectResponse({ Body: Readable.from([Buffer.alloc(BODY.length)]) })
          : next(),
    });
    const result = await h.probe(EVENT);
    expect(result.completedCases.at(-1)).toMatchObject({
      case: CASES[indexToChange],
      status: 'FAIL',
      code: 'BODY_MISMATCH',
    });
    expect(h.s3.send).toHaveBeenCalledTimes(indexToChange + 1);
  });
});

describe('DeleteObjects embedded denial evidence', () => {
  it('accepts HTTP200 only with the single exact requested AccessDenied entry for each version form', async () => {
    const h = setup({
      override: (command, _, next) =>
        command instanceof DeleteObjectsCommand ? batchDenied(command) : next(),
    });
    const result = await h.probe(EVENT);
    expect(result.code).toBe('CHECKS_COMPLETED');
    expect(
      result.completedCases
        .filter((entry) => entry.case.startsWith('delete_objects'))
        .map((entry) => entry.code),
    ).toEqual(['ALL_ITEMS_ACCESS_DENIED', 'ALL_ITEMS_ACCESS_DENIED']);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it.each([
    ['empty', () => ({ Errors: [] })],
    ['absent', () => ({ Errors: undefined })],
    ['null', () => ({ Errors: null })],
    ['wrong key', (value) => ({ Errors: [{ ...value.Errors[0], Key: `${PREFIX}other.txt` }] })],
    [
      'wrong version',
      (value) => ({ Errors: [{ ...value.Errors[0], VersionId: 'wrong-version' }] }),
    ],
    ['null version', (value) => ({ Errors: [{ ...value.Errors[0], VersionId: null }] })],
    ['wrong code', (value) => ({ Errors: [{ ...value.Errors[0], Code: 'InternalError' }] })],
    ['extra errors', (value) => ({ Errors: [...value.Errors, ...value.Errors] })],
    ['deleted', () => ({ Deleted: [{ Key: SOURCE }] })],
    ['mixed', () => ({ Deleted: [{ Key: `${PREFIX}other.txt` }] })],
    ['malformed deleted', () => ({ Deleted: {} })],
    ['malformed item', () => ({ Errors: [null] })],
    ['wrong HTTP status', () => ({ $metadata: metadata(201) })],
  ])('rejects batch %s responses and stops', async (_, alter) => {
    const h = setup({
      override: (command, __, next) => {
        if (!(command instanceof DeleteObjectsCommand)) return next();
        const value = batchDenied(command);
        return { ...value, ...alter(value) };
      },
    });
    const result = await h.probe(EVENT);
    expect(result.code).toBe('STOPPED');
    expect(result.completedCases.at(-1).status).toBe('FAIL');
    expect(h.s3.send).toHaveBeenCalledTimes(17);
  });

  it('requires the version on an exact-version batch denial', async () => {
    const h = setup({
      override: (command, _, next) => {
        if (!(command instanceof DeleteObjectsCommand)) return next();
        return { $metadata: metadata(), Errors: [{ Key: SOURCE, Code: 'AccessDenied' }] };
      },
    });
    const result = await h.probe(EVENT);
    expect(result.code).toBe('STOPPED');
    expect(result.completedCases.at(-1).case).toBe('delete_objects_version');
    expect(h.s3.send).toHaveBeenCalledTimes(18);
  });
});

describe('positive prerequisites, replay and bounded body handling', () => {
  it.each([
    undefined,
    {},
    { VersionId: 'null' },
    { VersionId: '' },
    { VersionId: 'bad\nversion' },
    { VersionId: VERSION, ServerSideEncryption: 'aws:kms' },
  ])('stops after an invalid initial create response: %j', async (response) => {
    const h = setup({ override: (_, index, next) => (index === 0 ? response : next()) });
    expect((await h.probe(EVENT)).completedCases.at(-1)).toMatchObject({
      case: 'initial_create',
      status: 'FAIL',
    });
    expect(h.s3.send).toHaveBeenCalledTimes(1);
  });

  it.each([
    { VersionId: 'null' },
    { VersionId: 'changed-version' },
    { ServerSideEncryption: 'aws:kms' },
    { ETag: undefined },
    { ETag: '"bad"' },
    { $metadata: metadata(206) },
  ])('stops writes if a source-read prerequisite fails: %j', async (overrides) => {
    const body = Readable.from([BODY]);
    const h = setup({
      override: (_, index, next) =>
        index === 1 ? objectResponse({ ...overrides, Body: body }) : next(),
    });
    expect((await h.probe(EVENT)).code).toBe('STOPPED');
    expect(h.s3.send).toHaveBeenCalledTimes(2);
    expect(body.destroyed).toBe(true);
  });

  it('reuses a verified initial412 after a lost response and never claims fresh creation', async () => {
    let lost = true;
    const h = setup({
      override: (_, index, next) => {
        const value = next();
        if (index === 0 && lost) {
          lost = false;
          throw s3Error('NetworkingError', undefined);
        }
        return value;
      },
    });
    expect((await h.probe(EVENT)).code).toBe('STOPPED');
    const result = await h.probe(EVENT);
    expect(result.code).toBe('INCONCLUSIVE');
    expect(result.completedCases[0]).toMatchObject({
      case: 'initial_create',
      status: 'INCONCLUSIVE',
      code: 'INITIAL_CREATE_REUSED',
    });
    expect(result.completedCases.slice(1).every((entry) => entry.status === 'PASS')).toBe(true);
    expect(result.qualification).toBe('unverified');
  });

  it('uses new negative keys on repeated invocation, while source and adjacent target stay fixed', async () => {
    const h = setup();
    const first = await h.probe(EVENT);
    const second = await h.probe(EVENT);
    expect(second.code).toBe('INCONCLUSIVE');
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.generatedSyntheticPrefix).not.toBe(second.generatedSyntheticPrefix);
    const calls = h.s3.send.mock.calls;
    for (const index of [5, 6, 9, 10, 11, 12])
      expect(calls[index][0].input.Key).not.toBe(calls[index + CASES.length][0].input.Key);
    for (const index of [0, 13])
      expect(calls[index][0].input.Key).toBe(calls[index + CASES.length][0].input.Key);
  });

  it('does not mutate after replay412 if existing bytes are not exactly the fixed body', async () => {
    const h = setup({
      reused: true,
      override: (_, index, next) =>
        index === 1 ? objectResponse({ Body: Readable.from([Buffer.alloc(BODY.length)]) }) : next(),
    });
    expect((await h.probe(EVENT)).code).toBe('STOPPED');
    expect(h.s3.send).toHaveBeenCalledTimes(2);
  });

  it('does not run negative writes if the exact-version source is not readable', async () => {
    const h = setup({
      override: (_, index, next) => {
        if (index === 2) throw s3Error('AccessDenied', 403);
        return next();
      },
    });
    expect((await h.probe(EVENT)).completedCases.at(-1)).toMatchObject({
      case: 'initial_version_get',
      status: 'INCONCLUSIVE',
    });
    expect(h.s3.send).toHaveBeenCalledTimes(3);
  });

  it.each([
    'advertised oversize',
    'stream oversize',
    'wrong bytes',
    'stream error',
    'length mismatch',
  ])('bounds and destroys the body for %s', async (scenario) => {
    const body = new Readable({
      read() {
        if (scenario === 'stream error') this.destroy(new Error('PRIVATE stream error'));
        else {
          this.push(scenario === 'stream oversize' ? Buffer.alloc(257) : Buffer.alloc(BODY.length));
          this.push(null);
        }
      },
    });
    const response = objectResponse({
      Body: body,
      ContentLength:
        scenario === 'advertised oversize' ? 257 : scenario === 'length mismatch' ? 0 : BODY.length,
    });
    const h = setup({ override: (_, index, next) => (index === 1 ? response : next()) });
    const result = await h.probe(EVENT);
    expect(result.code).toBe('STOPPED');
    expect(h.s3.send).toHaveBeenCalledTimes(2);
    expect(body.destroyed).toBe(true);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('closes an async iterator after too many empty chunks without unbounded buffering', async () => {
    const iterator = {
      next: vi.fn(async () => ({ done: false, value: Buffer.alloc(0) })),
      return: vi.fn(async () => ({ done: true })),
    };
    const body = { [Symbol.asyncIterator]: () => iterator };
    const h = setup({
      override: (_, index, next) => (index === 1 ? objectResponse({ Body: body }) : next()),
    });
    expect((await h.probe(EVENT)).completedCases.at(-1).code).toBe('BODY_LIMIT_EXCEEDED');
    expect(iterator.next).toHaveBeenCalledTimes(257);
    expect(iterator.return).toHaveBeenCalledOnce();
  });

  it('cancels an unsupported body and suppresses cleanup errors', async () => {
    const body = {
      cancel: vi.fn(async () => {
        throw new Error('PRIVATE cleanup error');
      }),
    };
    const h = setup({
      override: (_, index, next) => (index === 1 ? objectResponse({ Body: body }) : next()),
    });
    const result = await h.probe(EVENT);
    expect(result.completedCases.at(-1).code).toBe('BODY_STREAM_INVALID');
    expect(body.cancel).toHaveBeenCalledOnce();
    expect(h.s3.send).toHaveBeenCalledTimes(2);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
  });

  it('times out a stalled stream, destroys it and prevents further mutations on the host', async () => {
    vi.useFakeTimers();
    const body = new Readable({ read() {} });
    const h = setup({
      override: (_, index, next) => (index === 1 ? objectResponse({ Body: body }) : next()),
    });
    const pending = h.probe(EVENT);
    await vi.advanceTimersByTimeAsync(5_000);
    const result = await pending;
    expect(result.completedCases.at(-1).code).toBe('TIMEOUT');
    expect(h.s3.send.mock.calls[1][1].abortSignal.aborted).toBe(true);
    expect(body.destroyed).toBe(true);
    expect((await h.probe(EVENT)).code).toBe('HOST_UNAVAILABLE');
    expect(h.s3.send).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('bounds an uncooperative send and destroys a body that arrives after timeout', async () => {
    vi.useFakeTimers();
    let resolve;
    const h = setup({
      override: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    const pending = h.probe(EVENT);
    await vi.advanceTimersByTimeAsync(5_000);
    expect((await pending).code).toBe('STOPPED');
    const body = Readable.from([BODY]);
    resolve(objectResponse({ Body: body }));
    await vi.advanceTimersByTimeAsync(0);
    expect(body.destroyed).toBe(true);
    expect(h.s3.send).toHaveBeenCalledTimes(1);
  });

  it('stops within the total sixty-second budget even if each operation finishes within five seconds', async () => {
    vi.useFakeTimers();
    const h = setup({
      override: async (_, __, next) => {
        await new Promise((resolve) => setTimeout(resolve, 4_000));
        return next();
      },
    });
    const pending = h.probe(EVENT);
    await vi.advanceTimersByTimeAsync(60_000);
    const result = await pending;
    expect(result.code).toBe('STOPPED');
    expect(result.completedCases.at(-1).code).toBe('TIMEOUT');
    expect(h.s3.send).toHaveBeenCalledTimes(15);
  });

  it('rejects concurrent invocations before any second I/O', async () => {
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const h = setup({
      override: async (_, index, next) => {
        if (index === 0) await gate;
        return next();
      },
    });
    const pending = h.probe(EVENT);
    expect((await h.probe(EVENT)).code).toBe('HOST_UNAVAILABLE');
    expect(h.s3.send).toHaveBeenCalledTimes(1);
    release();
    expect((await pending).code).toBe('CHECKS_COMPLETED');
  });

  it('returns allowlisted diagnostics only, without messages, headers, bodies or arbitrary error codes', async () => {
    const log = vi.spyOn(console, 'log');
    const errorLog = vi.spyOn(console, 'error');
    const warn = vi.spyOn(console, 'warn');
    const error = Object.assign(s3Error('PRIVATE name', 503), {
      code: 'PRIVATE code',
      $metadata: {
        ...metadata(503),
        requestId: 'request-id\n',
        extendedRequestId: 'PRIVATE extended',
      },
      VersionId: 'version\n',
      $response: { headers: { authorization: 'PRIVATE credential' }, body: 'PRIVATE body' },
    });
    const h = setup({
      override: () => {
        throw error;
      },
    });
    const result = await h.probe(EVENT);
    expect(result.completedCases).toEqual([
      {
        case: 'initial_create',
        status: 'INCONCLUSIVE',
        code: 'UNEXPECTED_S3_ERROR',
        httpStatusCode: 503,
        attempts: 1,
        timestamp: expect.any(String),
        key: SOURCE,
        syntheticBody: bodyEvidence(BODY),
      },
    ]);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(log).not.toHaveBeenCalled();
    expect(errorLog).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
  });

  it.each([undefined, 0, -1, 1.5, '1', NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    'omits missing or invalid SDK attempt metadata: %s',
    async (attempts) => {
      const h = setup({
        override: () => {
          throw Object.assign(s3Error('BadDigest', 400), {
            $metadata: { ...metadata(400), attempts },
            Key: 'PRIVATE non-synthetic key',
          });
        },
      });
      const result = await h.probe(EVENT);
      expect(result.completedCases[0]).toMatchObject({
        key: SOURCE,
        observedErrorName: 'BadDigest',
        code: 'UNEXPECTED_S3_ERROR',
      });
      expect(result.completedCases[0]).not.toHaveProperty('attempts');
      expect(JSON.stringify(result)).not.toContain('PRIVATE');
    },
  );

  it('preserves observed SDK attempt counts instead of inventing one', async () => {
    const h = setup({
      override: () => {
        throw Object.assign(s3Error('SignatureDoesNotMatch', 403), {
          $metadata: { ...metadata(403), attempts: 2 },
        });
      },
    });
    expect((await h.probe(EVENT)).completedCases[0]).toMatchObject({
      observedErrorName: 'SignatureDoesNotMatch',
      attempts: 2,
      status: 'INCONCLUSIVE',
    });
  });

  it('retains request diagnostics when bounded body validation fails after an HTTP200 response', async () => {
    const h = setup({
      override: (_, index, next) =>
        index === 1 ? objectResponse({ Body: Readable.from([Buffer.alloc(BODY.length)]) }) : next(),
    });
    expect((await h.probe(EVENT)).completedCases.at(-1)).toMatchObject({
      code: 'BODY_MISMATCH',
      key: SOURCE,
      httpStatusCode: 200,
      attempts: 1,
      requestId: 'safe-request-id',
    });
  });
});

describe('installed SDK wire serialization without network', () => {
  const transport = () => {
    const requests = [];
    const client = new S3Client({
      region: 'us-east-1',
      credentials: { accessKeyId: 'synthetic-access-key', secretAccessKey: 'synthetic-secret' },
      maxAttempts: 1,
      requestHandler: {
        handle: async (request) => {
          requests.push(request);
          return {
            response: {
              statusCode: 403,
              headers: { 'content-type': 'application/xml', 'x-amz-request-id': 'safe-request-id' },
              body: Readable.from([
                '<Error><Code>AccessDenied</Code><Message>Synthetic denial</Message></Error>',
              ]),
            },
          };
        },
      },
    });
    return { client, requests };
  };
  const signedHeaders = (request) =>
    request.headers.authorization?.match(/\bSignedHeaders=([^,\s]+)/)?.[1].split(';') ?? [];

  it('serializes destination IfNoneMatch and excludes tag/annotation permission confounds', async () => {
    const h = setup();
    await h.probe(EVENT);
    const copies = h.s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof CopyObjectCommand);
    const { client, requests } = transport();
    try {
      for (const copy of copies) {
        await expect(client.send(copy)).rejects.toMatchObject({
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403, attempts: 1 },
        });
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.method).toBe('PUT');
        expect(request.headers).toMatchObject({
          'x-amz-expected-bucket-owner': CONFIG.expectedBucketOwner,
          'x-amz-source-expected-bucket-owner': CONFIG.expectedBucketOwner,
          'x-amz-copy-source': `${CONFIG.bucket}/${SOURCE}?versionId=${VERSION}`,
          'x-amz-metadata-directive': 'REPLACE',
          'x-amz-tagging-directive': 'REPLACE',
          'x-amz-object-annotation-directive': 'EXCLUDE',
        });
        expect(request.headers['x-amz-tagging'] ?? '').toBe('');
        expect(request.headers).not.toHaveProperty('x-amz-copy-source-if-none-match');
      }
      expect(requests[0].headers).not.toHaveProperty('if-none-match');
      expect(requests[1].headers['if-none-match']).toBe('*');
      expect(signedHeaders(requests[1])).toContain('if-none-match');
    } finally {
      client.destroy();
    }
  });

  it('sends explicit SHA256 for each fixed PUT body, including conflicting bytes', async () => {
    const h = setup();
    await h.probe(EVENT);
    const puts = h.s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof PutObjectCommand);
    const { client, requests } = transport();
    try {
      for (const put of puts)
        await expect(client.send(put)).rejects.toMatchObject({ name: 'AccessDenied' });
      expect(requests).toHaveLength(puts.length);
      for (const [index, request] of requests.entries()) {
        const checksum = createHash('sha256').update(puts[index].input.Body).digest('base64');
        expect(request.headers['x-amz-checksum-sha256']).toBe(checksum);
        expect(createHash('sha256').update(request.body).digest('base64')).toBe(checksum);
        expect(signedHeaders(request)).toContain('x-amz-checksum-sha256');
      }
      expect(
        new Set(requests.map((request) => request.headers['x-amz-checksum-sha256'])).size,
      ).toBe(2);
    } finally {
      client.destroy();
    }
  });

  it('serializes and signs the injected multipart condition, keeping the ordinary variant separate', async () => {
    const h = setup();
    await h.probe(EVENT);
    const commands = h.s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof CreateMultipartUploadCommand);
    const { client, requests } = transport();
    try {
      expect(commands).toHaveLength(2);
      for (const command of commands) {
        expect(command.input).not.toHaveProperty('IfNoneMatch');
        await expect(client.send(command)).rejects.toMatchObject({
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403, attempts: 1 },
        });
      }
      expect(requests).toHaveLength(2);
      for (const request of requests) {
        expect(request.method).toBe('POST');
        expect(request.headers['x-amz-expected-bucket-owner']).toBe(CONFIG.expectedBucketOwner);
        expect(request.query).toHaveProperty('uploads');
      }
      expect(requests[0].headers['if-none-match']).toBeUndefined();
      expect(signedHeaders(requests[0])).not.toContain('if-none-match');
      expect(requests[1].headers['if-none-match']).toBe('*');
      expect(signedHeaders(requests[1])).toContain('if-none-match');
      expect(requests[0].path === requests[1].path).toBe(false);
    } finally {
      client.destroy();
    }
  });

  it('signs Content-MD5 of the actual serialized XML for both DeleteObjects variants', async () => {
    const h = setup();
    await h.probe(EVENT);
    const commands = h.s3.send.mock.calls
      .map(([command]) => command)
      .filter((command) => command instanceof DeleteObjectsCommand);
    const { client, requests } = transport();
    try {
      for (const command of commands)
        await expect(client.send(command)).rejects.toMatchObject({
          name: 'AccessDenied',
          $metadata: { httpStatusCode: 403, attempts: 1 },
        });
      expect(requests).toHaveLength(2);
      for (const [index, request] of requests.entries()) {
        expect(request.method).toBe('POST');
        expect(request.headers['x-amz-expected-bucket-owner']).toBe(CONFIG.expectedBucketOwner);
        expect(typeof request.body).toBe('string');
        expect(request.body.includes('<Delete ')).toBe(true);
        expect(request.body.includes('<VersionId>')).toBe(index === 1);
        expect(request.headers['content-md5']).toBe(
          createHash('md5').update(request.body).digest('base64'),
        );
        expect(signedHeaders(request)).toContain('content-md5');
      }
      expect(requests[0].headers['content-md5'] === requests[1].headers['content-md5']).toBe(false);
    } finally {
      client.destroy();
    }
  });
});
