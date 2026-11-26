// Temporary, explicitly enabled storage evidence only. Never imports the worker.
import { createHash, randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  DeleteObjectsCommand,
} from '@aws-sdk/client-s3';

const BODY = Buffer.from('native-package-storage-probe/v1\n');
const CONFLICT = Buffer.from('native-package-storage-probe/v1/conflict\n');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const INVALID_TOKEN_CHARACTER = /[^A-Za-z0-9._~+/=-]/;
const OPERATION_MS = 5_000;
const TOTAL_MS = 60_000;
const MAX_BODY_BYTES = 256;
const MAX_CASES = 20;
const ERROR_NAMES = new Set([
  'AccessDenied',
  'PreconditionFailed',
  'Forbidden',
  'InvalidArgument',
  'InvalidRequest',
  'NotImplemented',
  'BadDigest',
  'InvalidDigest',
  'NoSuchBucket',
  'NoSuchKey',
  'NoSuchVersion',
  'InvalidBucketName',
  'InvalidBucketState',
  'InvalidToken',
  'ExpiredToken',
  'InvalidAccessKeyId',
  'SignatureDoesNotMatch',
  'AuthorizationHeaderMalformed',
  'PermanentRedirect',
  'TemporaryRedirect',
  'RequestTimeout',
  'TimeoutError',
  'AbortError',
  'NetworkingError',
  'SlowDown',
  'ServiceUnavailable',
  'InternalError',
  'ConditionalRequestConflict',
  'MethodNotAllowed',
  'NotFound',
  'CredentialsProviderError',
  'TokenProviderError',
]);
const bodyEvidence = (body) => ({
  byteLength: body.length,
  sha256: createHash('sha256').update(body).digest('hex'),
});
const token = (value, max = 1024) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  !INVALID_TOKEN_CHARACTER.test(value);
const version = (value) => token(value) && value !== 'null';
const validRunId = (value) => typeof value === 'string' && value.length === 36 && UUID.test(value);
const metadata = (value, observedErrorName = value?.name) => ({
  ...(Number.isInteger(value?.$metadata?.httpStatusCode) &&
  value.$metadata.httpStatusCode >= 100 &&
  value.$metadata.httpStatusCode <= 599
    ? { httpStatusCode: value.$metadata.httpStatusCode }
    : {}),
  ...(token(value?.$metadata?.requestId, 128) ? { requestId: value.$metadata.requestId } : {}),
  ...(version(value?.VersionId) ? { versionId: value.VersionId } : {}),
  ...(Number.isSafeInteger(value?.$metadata?.attempts) && value.$metadata.attempts > 0
    ? { attempts: value.$metadata.attempts }
    : {}),
  ...(ERROR_NAMES.has(observedErrorName) ? { observedErrorName } : {}),
});
// A matching name alone, or a matching HTTP status alone, is never denial proof.
const isError = (error, name, status) =>
  error?.name === name && error?.$metadata?.httpStatusCode === status;

class ProbeError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
const fail = (code) => {
  throw new ProbeError(code);
};

// Build runs after serialization and before finalizeRequest/signing. Do not put
// the multipart condition in command.input: the SDK silently ignores that field.
const withMultipartCondition = (command) => {
  command.middlewareStack.add(
    (next) => async (args) => {
      args.request.headers['if-none-match'] = '*';
      return next(args);
    },
    { step: 'build', priority: 'low', name: 'storageProbeMultipartCondition' },
  );
  return command;
};
const withDeleteMd5 = (command) => {
  command.middlewareStack.add(
    (next) => async (args) => {
      const body = args.request.body;
      if (
        (typeof body !== 'string' && !(body instanceof Uint8Array)) ||
        Buffer.byteLength(body) === 0 ||
        Buffer.byteLength(body) > 8_192
      )
        fail('DELETE_XML_INVALID');
      args.request.headers['content-md5'] = createHash('md5').update(body).digest('base64');
      return next(args);
    },
    { step: 'build', priority: 'low', name: 'storageProbeDeleteMd5' },
  );
  return command;
};

const dispose = (body, iterator) => {
  try {
    const result =
      typeof body?.destroy === 'function'
        ? body.destroy()
        : typeof iterator?.return === 'function'
          ? iterator.return()
          : body?.cancel?.();
    Promise.resolve(result).catch(() => {});
  } catch {
    // Cleanup must not expose stream/provider diagnostics.
  }
};

const readBody = async (response, signal) => {
  const body = response.Body;
  let iterator;
  let closed = false;
  const close = () => {
    if (!closed) {
      closed = true;
      dispose(body, iterator);
    }
  };
  signal.addEventListener('abort', close, { once: true });
  try {
    if (
      !Number.isSafeInteger(response.ContentLength) ||
      response.ContentLength < 0 ||
      response.ContentLength > MAX_BODY_BYTES
    )
      fail('BODY_SIZE_INVALID');
    if (typeof body?.[Symbol.asyncIterator] !== 'function') fail('BODY_STREAM_INVALID');
    iterator = body[Symbol.asyncIterator]();
    const chunks = [];
    let size = 0;
    let count = 0;
    while (true) {
      if (signal.aborted) fail('TIMEOUT');
      const part = await iterator.next();
      if (part.done) break;
      if (!(part.value instanceof Uint8Array)) fail('BODY_STREAM_INVALID');
      size += part.value.byteLength;
      // Also bound empty/tiny chunks, not just the accumulated bytes.
      if (size > MAX_BODY_BYTES || ++count > MAX_BODY_BYTES) fail('BODY_LIMIT_EXCEEDED');
      chunks.push(Buffer.from(part.value));
    }
    if (size !== response.ContentLength || !Buffer.concat(chunks, size).equals(BODY))
      fail('BODY_MISMATCH');
  } finally {
    signal.removeEventListener('abort', close);
    close();
  }
};

const defaultS3 = () =>
  new S3Client({
    maxAttempts: 1,
    requestHandler: {
      connectionTimeout: 2_000,
      requestTimeout: 4_000,
      socketTimeout: 4_000,
      throwOnRequestTimeout: true,
    },
  });

/**
 * Config and S3 are trusted host inputs. The event supplies only the configured
 * run ID. Fresh negative targets are generated internally on every invocation;
 * the source and the single adjacent-prefix target remain fixed for replay.
 */
export const createNativePackageStorageProbe = ({
  s3,
  enabled = false,
  bucket,
  expectedBucketOwner,
  runId,
} = {}) => {
  let active = false;
  // An ambiguous timeout must not allow this host to start more mutations.
  let timedOut = false;
  return async (event) => {
    const prefix = validRunId(runId) ? `native-packages/v1/__qualification__/${runId}/` : null;
    const result = {
      schemaVersion: 1,
      kind: 'native_package_storage_probe',
      qualification: 'unverified',
      runId: validRunId(runId) ? runId : null,
      runtime: { arch: process.arch, nodeVersion: process.version },
      plannedSyntheticPrefix: prefix,
      syntheticBodies: { source: bodyEvidence(BODY), conflict: bodyEvidence(CONFLICT) },
      maxCases: MAX_CASES,
      code: 'REJECTED',
      completedCases: [],
    };
    const reject = (code) => ({ ...result, code });
    if (
      enabled !== true ||
      process.env.NATIVE_PACKAGE_STORAGE_PROBE_ENABLED !== 'true' ||
      process.env.NATIVE_PACKAGE_JOBS_ENABLED !== 'false'
    )
      return reject('DISABLED');
    if (
      !prefix ||
      typeof bucket !== 'string' ||
      !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) ||
      bucket !== bucket.trim() ||
      bucket.includes('..') ||
      bucket.includes('.-') ||
      bucket.includes('-.') ||
      /^\d+\.\d+\.\d+\.\d+$/.test(bucket) ||
      typeof expectedBucketOwner !== 'string' ||
      expectedBucketOwner.length !== 12 ||
      !/^\d{12}$/.test(expectedBucketOwner) ||
      (s3 !== undefined && typeof s3?.send !== 'function')
    )
      return reject('INVALID_CONFIG');
    if (
      event === null ||
      typeof event !== 'object' ||
      Object.getPrototypeOf(event) !== Object.prototype ||
      Reflect.ownKeys(event).length !== 2 ||
      !Object.hasOwn(event, 'schemaVersion') ||
      !Object.hasOwn(event, 'runId') ||
      event.schemaVersion !== 1 ||
      event.runId !== runId
    )
      return reject('INVALID_REQUEST');
    if (active || timedOut) return reject('HOST_UNAVAILABLE');
    active = true;
    let client;
    const deadline = Date.now() + TOTAL_MS;
    const base = { Bucket: bucket, ExpectedBucketOwner: expectedBucketOwner };
    const source = `${prefix}source.txt`;
    const nonce = randomUUID();
    result.nonce = nonce;
    result.generatedSyntheticPrefix = `${prefix}${nonce}/`;
    const fresh = (name) => `${result.generatedSyntheticPrefix}${name}`;
    let currentKey = source;
    let currentBody;
    let requestedVersionId;
    let responseMetadata;
    let requests = 0;
    const record = (name, status, code, value, observedErrorName) =>
      result.completedCases.push({
        case: name,
        status,
        code,
        timestamp: new Date().toISOString(),
        key: currentKey,
        ...(currentBody ? { syntheticBody: currentBody } : {}),
        ...(requestedVersionId ? { requestedVersionId } : {}),
        ...responseMetadata,
        ...metadata(value, observedErrorName),
      });
    let currentCase = 'initial_create';
    let sourceVersion;
    let etag;

    const execute = async (command, read = false) => {
      // Capture only our generated inputs, never keys or body data from S3 errors.
      const entry = command.input.Delete?.Objects[0] ?? command.input;
      currentKey = entry.Key;
      requestedVersionId = version(entry.VersionId) ? entry.VersionId : undefined;
      currentBody =
        command instanceof PutObjectCommand ? bodyEvidence(command.input.Body) : undefined;
      responseMetadata = undefined;
      if (++requests > MAX_CASES) fail('CASE_LIMIT_EXCEEDED');
      const remaining = Math.min(OPERATION_MS, deadline - Date.now());
      if (remaining <= 0) {
        timedOut = true;
        fail('TIMEOUT');
      }
      const controller = new AbortController();
      let timer;
      const timeout = new Promise((_, rejectTimeout) => {
        timer = setTimeout(() => {
          timedOut = true;
          controller.abort();
          rejectTimeout(new ProbeError('TIMEOUT'));
        }, remaining);
      });
      try {
        return await Promise.race([
          timeout,
          (async () => {
            const response = await client.send(command, { abortSignal: controller.signal });
            responseMetadata = metadata(response);
            if (controller.signal.aborted) {
              dispose(response?.Body);
              fail('TIMEOUT');
            }
            if (read) await readBody(response, controller.signal);
            return response;
          })(),
        ]);
      } finally {
        clearTimeout(timer);
      }
    };
    const put = (Key, Body = BODY, condition = { IfNoneMatch: '*' }) =>
      new PutObjectCommand({
        ...base,
        Key,
        Body: Buffer.from(Body),
        ContentLength: Body.length,
        ChecksumSHA256: createHash('sha256').update(Body).digest('base64'),
        ServerSideEncryption: 'AES256',
        ...condition,
      });
    const read = async (name, exact) => {
      currentCase = name;
      const value = await execute(
        new GetObjectCommand({
          ...base,
          Key: source,
          ...(exact ? { VersionId: sourceVersion } : {}),
        }),
        true,
      );
      if (
        value.$metadata?.httpStatusCode !== 200 ||
        !version(value.VersionId) ||
        (sourceVersion !== undefined && value.VersionId !== sourceVersion) ||
        value.ServerSideEncryption !== 'AES256' ||
        typeof value.ETag !== 'string' ||
        value.ETag.length !== 34 ||
        !/^"[a-fA-F0-9]{32}"$/.test(value.ETag) ||
        (etag !== undefined && value.ETag !== etag)
      )
        fail('READ_PREREQUISITE_FAILED');
      sourceVersion = value.VersionId;
      etag = value.ETag;
      record(name, 'PASS', 'FIXED_BYTES_VERSION_AES256', value);
    };
    const denied = async (name, command, expectedName = 'AccessDenied', expectedStatus = 403) => {
      currentCase = name;
      let value;
      try {
        value = await execute(command);
      } catch (error) {
        if (isError(error, expectedName, expectedStatus)) {
          record(
            name,
            'PASS',
            expectedName === 'AccessDenied' ? 'ACCESS_DENIED' : 'PRECONDITION_FAILED',
            error,
          );
          return;
        }
        if (
          name === 'wrong_condition_put' &&
          command instanceof PutObjectCommand &&
          command.input.IfNoneMatch === '"wrong"' &&
          isError(error, 'NotImplemented', 501)
        ) {
          record(name, 'INCONCLUSIVE', 'CONDITION_NOT_IMPLEMENTED', error);
          return;
        }
        if (
          command instanceof CopyObjectCommand &&
          [400, 501].includes(error?.$metadata?.httpStatusCode)
        ) {
          record(
            name,
            'INCONCLUSIVE',
            error.$metadata.httpStatusCode === 501
              ? 'COPY_NOT_IMPLEMENTED'
              : 'COPY_REQUEST_REJECTED',
            error,
          );
          return;
        }
        if (
          name === 'create_multipart_upload_condition' &&
          [400, 501].includes(error?.$metadata?.httpStatusCode)
        ) {
          record(name, 'INCONCLUSIVE', 'MULTIPART_CONDITION_REJECTED', error);
          return;
        }
        throw error;
      }
      if (command instanceof DeleteObjectsCommand && value?.$metadata?.httpStatusCode === 200) {
        const expected = command.input.Delete.Objects[0];
        const errors = value.Errors;
        if (
          (value.Deleted === undefined ||
            (Array.isArray(value.Deleted) && value.Deleted.length === 0)) &&
          Array.isArray(errors) &&
          errors.length === 1 &&
          errors[0]?.Code === 'AccessDenied' &&
          errors[0].Key === expected.Key &&
          errors[0].VersionId === expected.VersionId
        ) {
          record(name, 'PASS', 'ALL_ITEMS_ACCESS_DENIED', value, 'AccessDenied');
          return;
        }
      }
      if (command instanceof CreateMultipartUploadCommand && token(value?.UploadId, 2048))
        result.operatorCleanup = { key: currentKey, UploadId: value.UploadId };
      record(name, 'FAIL', 'UNEXPECTED_MUTATION_RESPONSE', value);
      fail('STOP_RECORDED');
    };

    try {
      client = s3 ?? defaultS3();
      let created;
      let reused = false;
      try {
        created = await execute(put(source));
      } catch (error) {
        if (!isError(error, 'PreconditionFailed', 412)) throw error;
        reused = true;
        record(currentCase, 'INCONCLUSIVE', 'INITIAL_CREATE_REUSED', error);
      }
      if (!reused) {
        if (
          created?.$metadata?.httpStatusCode !== 200 ||
          !version(created?.VersionId) ||
          created?.ServerSideEncryption !== 'AES256'
        )
          fail('CREATE_PREREQUISITE_FAILED');
        sourceVersion = created.VersionId;
        record(currentCase, 'PASS', 'NEW_VERSION_CREATED', created);
      }
      await read('initial_current_get', false);
      await read('initial_version_get', true);
      await denied('identical_conditional_put', put(source), 'PreconditionFailed', 412);
      await denied('conflicting_conditional_put', put(source, CONFLICT), 'PreconditionFailed', 412);
      await denied('missing_condition_put', put(fresh('missing-condition.txt'), BODY, {}));
      await denied(
        'wrong_condition_put',
        put(fresh('wrong-condition.txt'), BODY, { IfNoneMatch: '"wrong"' }),
      );
      await denied('if_match_overwrite', put(source, CONFLICT, { IfMatch: etag }));
      await denied('unconditional_overwrite', put(source, CONFLICT, {}));
      for (const conditional of [false, true]) {
        await denied(
          conditional ? 'copy_destination_condition' : 'copy_without_condition',
          new CopyObjectCommand({
            ...base,
            Key: fresh(conditional ? 'copy-conditional.txt' : 'copy.txt'),
            CopySource: `${bucket}/${source}?versionId=${encodeURIComponent(sourceVersion)}`,
            ExpectedSourceBucketOwner: expectedBucketOwner,
            MetadataDirective: 'REPLACE',
            Metadata: {},
            TaggingDirective: 'REPLACE',
            Tagging: '',
            AnnotationDirective: 'EXCLUDE',
            ServerSideEncryption: 'AES256',
            ...(conditional ? { IfNoneMatch: '*' } : {}),
          }),
        );
      }
      await denied(
        'create_multipart_upload',
        new CreateMultipartUploadCommand({
          ...base,
          Key: fresh('multipart.txt'),
          ServerSideEncryption: 'AES256',
        }),
      );
      await denied(
        'create_multipart_upload_condition',
        withMultipartCondition(
          new CreateMultipartUploadCommand({
            ...base,
            Key: fresh('multipart-conditional.txt'),
            ServerSideEncryption: 'AES256',
          }),
        ),
      );
      await denied(
        'adjacent_prefix_put',
        put(`native-packages/__qualification__/${runId}/outside-prefix.txt`),
      );
      await denied('delete_current', new DeleteObjectCommand({ ...base, Key: source }));
      await denied(
        'delete_version',
        new DeleteObjectCommand({ ...base, Key: source, VersionId: sourceVersion }),
      );
      for (const exact of [false, true]) {
        await denied(
          exact ? 'delete_objects_version' : 'delete_objects_current',
          withDeleteMd5(
            new DeleteObjectsCommand({
              ...base,
              Delete: {
                Objects: [{ Key: source, ...(exact ? { VersionId: sourceVersion } : {}) }],
                Quiet: false,
              },
            }),
          ),
        );
      }
      await read('final_current_get', false);
      await read('final_version_get', true);
      result.code = result.completedCases.some(({ status }) => status === 'INCONCLUSIVE')
        ? 'INCONCLUSIVE'
        : 'CHECKS_COMPLETED';
    } catch (error) {
      if (!(error instanceof ProbeError && error.code === 'STOP_RECORDED'))
        record(
          currentCase,
          error instanceof ProbeError && error.code !== 'TIMEOUT' ? 'FAIL' : 'INCONCLUSIVE',
          error instanceof ProbeError ? error.code : 'UNEXPECTED_S3_ERROR',
          error,
        );
      result.code = 'STOPPED';
    } finally {
      active = false;
      if (s3 === undefined) client?.destroy();
    }
    return result;
  };
};

let defaultProbe;
export const handler = async (event) => {
  defaultProbe ??= createNativePackageStorageProbe({
    enabled: process.env.NATIVE_PACKAGE_STORAGE_PROBE_ENABLED === 'true',
    bucket: process.env.NATIVE_PACKAGES_BUCKET,
    expectedBucketOwner: process.env.NATIVE_PACKAGES_EXPECTED_BUCKET_OWNER,
    runId: process.env.NATIVE_PACKAGE_STORAGE_PROBE_RUN_ID,
  });
  return defaultProbe(event);
};
