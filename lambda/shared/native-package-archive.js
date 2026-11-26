// Durable bytes only: callers authorize before/after archive operations and at
// the required callback boundaries. Nothing here grants execution permission.
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, realpath, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, normalize, parse } from 'node:path';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { describeNativePackagePin } from './native-package-pin.js';
import { NativePackageError, verifyNativeReleaseDirectory } from './native-runtime-package.js';
import { WorkflowSourceError, workflowSourceIdentity } from './workflow-source-bindings.js';
import { canonicalJson } from './workflow-checkpoint.js';

const RECORD_BYTES = 1024 * 1024;
const IO_TIMEOUT_MS = 120_000;
const MESSAGES = Object.freeze({
  native_package_archive_invalid: 'Native package archive inputs are invalid',
  native_package_archive_not_found: 'Native package archive is not committed',
  native_package_archive_corrupt: 'Native package archive bytes or identity are inconsistent',
  native_package_archive_busy: 'Native package archive publication is busy; retry unchanged',
  native_package_archive_unavailable: 'Native package archive storage is unavailable',
  native_package_archive_cleanup: 'Native package archive staging cleanup failed',
});

export class NativePackageArchiveError extends Error {
  constructor(code = 'native_package_archive_invalid') {
    const safeCode =
      typeof code === 'string' && Object.hasOwn(MESSAGES, code)
        ? code
        : 'native_package_archive_invalid';
    super(MESSAGES[safeCode]);
    this.name = 'NativePackageArchiveError';
    this.code = safeCode;
  }
}

const fail = (suffix) => {
  throw new NativePackageArchiveError(`native_package_archive_${suffix}`);
};
const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
const matches = (value, pattern) => typeof value === 'string' && pattern.exec(value)?.[0] === value;
const absolute = (value) =>
  typeof value === 'string' &&
  value.length <= 4096 &&
  isAbsolute(value) &&
  normalize(value) === value &&
  ![...value].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
const version = (value) => value !== 'null' && matches(value, /^[A-Za-z0-9._~+/=-]{1,1024}$/);
const record = (value, keys) =>
  value !== null &&
  typeof value === 'object' &&
  Object.getPrototypeOf(value) === Object.prototype &&
  Object.keys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));

// Metadata identity only. This receipt is neither current source authority nor
// evidence that the referenced S3 bytes have been read or remain available.
export const describeNativePackageArchiveReceipt = (receipt, materializationId) => {
  let snapshot;
  try {
    snapshot = structuredClone(receipt);
  } catch {
    fail('invalid');
  }
  if (
    !matches(materializationId, /^sha256:[a-f0-9]{64}$/) ||
    !record(snapshot, ['schemaVersion', 'materializationId', 'manifest']) ||
    snapshot.schemaVersion !== 1 ||
    snapshot.materializationId !== materializationId ||
    !record(snapshot.manifest, ['versionId', 'sha256', 'bytes']) ||
    !version(snapshot.manifest.versionId) ||
    !matches(snapshot.manifest.sha256, /^[a-f0-9]{64}$/) ||
    !Number.isSafeInteger(snapshot.manifest.bytes) ||
    snapshot.manifest.bytes <= 0 ||
    snapshot.manifest.bytes > RECORD_BYTES
  )
    fail('invalid');
  Object.freeze(snapshot.manifest);
  return Object.freeze(snapshot);
};

const safeFailure = (error) => {
  if (error instanceof WorkflowSourceError) return error;
  if (error instanceof NativePackageArchiveError) return new NativePackageArchiveError(error.code);
  return new NativePackageArchiveError('native_package_archive_unavailable');
};
const authorize = async (callback) => {
  try {
    // The host callback must throw on denial. Its return value is never used as
    // authority, persisted, or sent to the storage or materializer ports.
    await callback();
  } catch (error) {
    throw safeFailure(error);
  }
};

const describe = (pin, attestation) => {
  try {
    return describeNativePackagePin(pin, attestation);
  } catch {
    fail('invalid');
  }
};
const scopeFor = (projectId, sourceId, pin) => {
  if (!matches(projectId, /^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/)) fail('invalid');
  let identity;
  try {
    identity = workflowSourceIdentity(pin.identity.source.provider, pin.identity.source.repository);
  } catch {
    fail('invalid');
  }
  if (sourceId !== identity.sourceId) fail('invalid');
  const scopeId = digest(canonicalJson({ schemaVersion: 1, projectId, sourceId }));
  return {
    projectId,
    sourceId,
    scopeId,
    prefix: `native-packages/v1/${scopeId}/${pin.materializationId.slice(7)}/`,
  };
};
const packagePin = (pin) => ({ ...pin.identity, packageId: pin.packageId });
const samePin = (left, right) =>
  left.materializationId === right.materializationId &&
  canonicalJson(left.identity) === canonicalJson(right.identity);

// Check ancestors before creating descendants. Root-owned sticky temporary
// directories are allowed; writable non-sticky parents and symlinks are not.
// Service paths must already use their canonical spelling (e.g. /private/tmp).
const privateDirectory = async (directory, create = false) => {
  let current = parse(directory).root;
  for (const part of directory.slice(current.length).split('/').filter(Boolean)) {
    current = join(current, part);
    let stat;
    try {
      stat = await lstat(current);
    } catch (error) {
      if (error.code !== 'ENOENT' || !create) throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (creationError) {
        if (creationError.code !== 'EEXIST') throw creationError;
      }
      stat = await lstat(current);
    }
    const trustedSticky =
      (stat.mode & 0o1000) !== 0 && (stat.uid === 0 || stat.uid === process.getuid?.());
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      (stat.uid !== 0 && stat.uid !== process.getuid?.()) ||
      ((stat.mode & 0o022) !== 0 && !trustedSticky) ||
      (current === directory && (stat.mode & 0o077) !== 0)
    )
      fail('invalid');
  }
};

const inspectDirectory = async (directory, files) => {
  await privateDirectory(directory);
  let count = 0;
  for await (const entry of await opendir(directory)) {
    count += 1;
    if (count > files.length || !entry.isFile() || !files.some((file) => file.name === entry.name))
      fail('corrupt');
  }
  if (count !== files.length) fail('corrupt');
};

// Open once without following links or blocking on a FIFO. Read a bounded
// descriptor snapshot, including one extra byte to reject concurrent growth.
const readLocal = async (directory, file) => {
  const handle = await open(
    join(directory, file.name),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.size > file.limit ||
      (file.bytes !== undefined && stat.size !== file.bytes)
    )
      fail('corrupt');
    const bytes = Buffer.alloc(stat.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) fail('corrupt');
      offset += read.bytesRead;
    }
    if ((await handle.read(Buffer.alloc(1), 0, 1, offset)).bytesRead !== 0) fail('corrupt');
    if (digest(bytes) !== file.sha256) fail('corrupt');
    return bytes;
  } finally {
    await handle.close();
  }
};

const discardBody = (body) => {
  try {
    if (typeof body?.destroy === 'function') body.destroy();
    else if (typeof body?.cancel === 'function') Promise.resolve(body.cancel()).catch(() => {});
  } catch {
    // A discarded SDK body cannot contribute bytes to a publication.
  }
};

// Keep both SDK waits and streaming bodies bounded. Late SDK completion cannot
// cause filesystem writes; its body is discarded before consumption.
const withDeadline = async (operation, timeoutMs) => {
  const controller = new AbortController();
  let timer;
  const expired = new Promise((_, reject) => {
    timer = setTimeout(() => {
      controller.abort();
      reject(new NativePackageArchiveError('native_package_archive_unavailable'));
    }, timeoutMs);
  });
  try {
    return await Promise.race([operation(controller.signal), expired]);
  } finally {
    clearTimeout(timer);
  }
};

const readBody = async (body, length, file, capture, signal) => {
  if (
    !Number.isSafeInteger(length) ||
    length < 0 ||
    length > file.limit ||
    (file.bytes !== undefined && length !== file.bytes)
  )
    fail('corrupt');
  const bytes = capture ? Buffer.alloc(length) : undefined;
  const hash = createHash('sha256');
  let offset = 0;
  const consume = (chunk) => {
    if (signal.aborted) fail('unavailable');
    if (!(chunk instanceof Uint8Array) || offset + chunk.byteLength > length) fail('corrupt');
    hash.update(chunk);
    if (bytes) bytes.set(chunk, offset);
    offset += chunk.byteLength;
  };
  if (typeof body?.getReader === 'function') {
    const reader = body.getReader();
    let ended = false;
    const cancel = () => {
      try {
        Promise.resolve(reader.cancel()).catch(() => {});
      } catch {
        // The enclosing operation still rejects and never publishes late bytes.
      }
    };
    signal.addEventListener('abort', cancel, { once: true });
    try {
      while (!ended) {
        if (signal.aborted) fail('unavailable');
        const next = await reader.read();
        if (signal.aborted) fail('unavailable');
        ended = next.done;
        if (!ended) consume(next.value);
      }
    } finally {
      signal.removeEventListener('abort', cancel);
      if (!ended) cancel();
      reader.releaseLock();
    }
  } else {
    const chunks = body instanceof Uint8Array ? [body] : body;
    if (!chunks || (!chunks[Symbol.asyncIterator] && !chunks[Symbol.iterator])) fail('corrupt');
    for await (const chunk of chunks) consume(chunk);
  }
  const sha256 = hash.digest('hex');
  if (offset !== length || (file.sha256 !== undefined && sha256 !== file.sha256)) fail('corrupt');
  return { bytes, sha256, length };
};

const sdkStatus = (error, status, names) =>
  names.includes(error?.name) || error?.$metadata?.httpStatusCode === status;

const manifestFor = (scope, pin, files) => ({
  schemaVersion: 1,
  projectId: scope.projectId,
  sourceId: scope.sourceId,
  packagePin: packagePin(pin),
  attestation: pin.attestation,
  materializationId: pin.materializationId,
  files,
});

const parseManifest = (bytes, scope, pin) => {
  try {
    const value = JSON.parse(bytes.toString('utf8'));
    if (
      !record(value, [
        'schemaVersion',
        'projectId',
        'sourceId',
        'packagePin',
        'attestation',
        'materializationId',
        'files',
      ]) ||
      value.schemaVersion !== 1 ||
      value.projectId !== scope.projectId ||
      value.sourceId !== scope.sourceId ||
      canonicalJson(value.packagePin) !== canonicalJson(packagePin(pin)) ||
      canonicalJson(value.attestation) !== canonicalJson(pin.attestation) ||
      value.materializationId !== pin.materializationId ||
      !Array.isArray(value.files) ||
      value.files.length !== pin.files.length ||
      canonicalJson(value) !== bytes.toString('utf8')
    )
      fail('corrupt');
    for (const [index, file] of value.files.entries()) {
      const expected = pin.files[index];
      if (
        !record(file, ['name', 'sha256', 'bytes', 'versionId']) ||
        file.name !== expected.name ||
        file.sha256 !== expected.sha256 ||
        !Number.isSafeInteger(file.bytes) ||
        file.bytes < 0 ||
        file.bytes > expected.limit ||
        (expected.bytes !== undefined && file.bytes !== expected.bytes) ||
        !version(file.versionId)
      )
        fail('corrupt');
    }
    return value;
  } catch {
    fail('corrupt');
  }
};

// The host canonicalizes its trusted workRoot once. Each S3 send plus body read
// shares one deadline (default/maximum 120s); no remote repair or deletion is
// attempted. Restore receipts pin a manifest version, never a floating key.
export const createNativePackageArchive = ({
  s3,
  bucket,
  expectedBucketOwner,
  workRoot,
  materialize,
  operationTimeoutMs = IO_TIMEOUT_MS,
} = {}) => {
  if (
    typeof s3?.send !== 'function' ||
    !matches(bucket, /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/) ||
    !matches(expectedBucketOwner, /^\d{12}$/) ||
    !absolute(workRoot) ||
    workRoot === parse(workRoot).root ||
    typeof materialize !== 'function' ||
    !Number.isSafeInteger(operationTimeoutMs) ||
    operationTimeoutMs < 1 ||
    operationTimeoutMs > IO_TIMEOUT_MS
  )
    fail('invalid');
  const base = { Bucket: bucket, ExpectedBucketOwner: expectedBucketOwner };
  const ownedStage = async () => {
    await privateDirectory(workRoot, true);
    return mkdtemp(join(await realpath(workRoot), 'archive-'));
  };
  const cleanup = async (stage) => {
    if (!stage) return;
    try {
      await rm(stage, { recursive: true, force: true });
    } catch {
      fail('cleanup');
    }
  };
  const get = (key, file, { versionId, capture = true, missing = 'corrupt' } = {}) =>
    withDeadline(async (signal) => {
      let response;
      const discard = () => discardBody(response?.Body);
      signal.addEventListener('abort', discard, { once: true });
      try {
        try {
          response = await s3.send(
            new GetObjectCommand({
              ...base,
              Key: key,
              ...(versionId === undefined ? {} : { VersionId: versionId }),
            }),
            { abortSignal: signal },
          );
        } catch (error) {
          if (sdkStatus(error, 404, ['NoSuchKey', 'NoSuchVersion', 'NotFound'])) fail(missing);
          throw error;
        }
        if (signal.aborted) fail('unavailable');
        if (!version(response.VersionId) || (versionId && response.VersionId !== versionId))
          fail('corrupt');
        const body = await readBody(response.Body, response.ContentLength, file, capture, signal);
        return { ...body, versionId: response.VersionId };
      } finally {
        signal.removeEventListener('abort', discard);
        discard();
      }
    }, operationTimeoutMs);
  const put = async (key, bytes) => {
    try {
      const response = await withDeadline(
        (signal) =>
          s3.send(
            new PutObjectCommand({
              ...base,
              Key: key,
              Body: bytes,
              IfNoneMatch: '*',
              ContentLength: bytes.length,
              ChecksumSHA256: createHash('sha256').update(bytes).digest('base64'),
            }),
            { abortSignal: signal },
          ),
        operationTimeoutMs,
      );
      if (!version(response?.VersionId)) fail('unavailable');
      return { versionId: response.VersionId, reused: false };
    } catch (error) {
      if (sdkStatus(error, 409, ['ConditionalRequestConflict'])) fail('busy');
      if (!sdkStatus(error, 412, ['PreconditionFailed'])) throw error;
      // A competing or earlier unacknowledged put is usable only after reading
      // and hashing its exact bytes, not from ETag/checksum metadata alone.
      const existing = await get(
        key,
        { bytes: bytes.length, sha256: digest(bytes), limit: bytes.length },
        { capture: false },
      );
      return { versionId: existing.versionId, reused: true };
    }
  };

  return Object.freeze({
    async publish({ projectId, sourceId, materialization, beforeCommit } = {}) {
      let stage;
      try {
        if (typeof beforeCommit !== 'function') fail('invalid');
        const pin = describe(materialization?.package, materialization?.attestation);
        const scope = scopeFor(projectId, sourceId, pin);
        const directory = materialization?.directory;
        if (!absolute(directory) || materialization.materializationId !== pin.materializationId)
          fail('invalid');
        await inspectDirectory(directory, pin.files);
        stage = await ownedStage();
        // Copy before release verification: the report and all S3 writes must
        // describe one exact private snapshot, never caller-supplied claims.
        for (const file of pin.files) {
          const bytes = await readLocal(directory, file);
          await writeFile(join(stage, file.name), bytes, { flag: 'wx', mode: 0o600 });
        }
        await inspectDirectory(directory, pin.files);
        try {
          const report = await verifyNativeReleaseDirectory({
            directory: stage,
            source: pin.identity.source,
            target: pin.identity.target,
          });
          if (!samePin(describe(report, pin.attestation), pin)) fail('corrupt');
        } catch {
          fail('corrupt');
        }
        const files = [];
        for (const file of pin.files) {
          const bytes = await readLocal(stage, file);
          const stored = await put(`${scope.prefix}files/${file.name}`, bytes);
          files.push({
            name: file.name,
            sha256: file.sha256,
            bytes: bytes.length,
            versionId: stored.versionId,
          });
        }
        const bytes = Buffer.from(canonicalJson(manifestFor(scope, pin, files)));
        if (bytes.length > RECORD_BYTES) fail('invalid');
        await authorize(beforeCommit);
        const committed = await put(`${scope.prefix}manifest.json`, bytes);
        // Reauthorization must follow reads needed to establish a reusable
        // commit too; callback receipts are intentionally ignored.
        if (committed.reused) await authorize(beforeCommit);
        return Object.freeze({
          schemaVersion: 1,
          materializationId: pin.materializationId,
          manifest: Object.freeze({
            versionId: committed.versionId,
            sha256: digest(bytes),
            bytes: bytes.length,
          }),
        });
      } catch (error) {
        throw safeFailure(error);
      } finally {
        await cleanup(stage);
      }
    },

    // Reconcile only the original candidate persisted by a protected job before
    // publish. This is the one receipt-free lookup of its fixed commit key;
    // every file read still names an exact VersionId. Never assemble partial
    // uploads or rediscover a provider release to manufacture a new candidate.
    async recoverReceipt({
      projectId,
      sourceId,
      pin: expectedPin,
      attestation,
      materializationId,
      beforeReturn,
    } = {}) {
      try {
        if (typeof beforeReturn !== 'function') fail('invalid');
        const pin = describe(expectedPin, attestation);
        const scope = scopeFor(projectId, sourceId, pin);
        if (materializationId !== pin.materializationId) fail('invalid');
        const committed = await get(
          `${scope.prefix}manifest.json`,
          { limit: RECORD_BYTES },
          { missing: 'not_found' },
        );
        const manifest = parseManifest(committed.bytes, scope, pin);
        for (const [index, file] of manifest.files.entries()) {
          await get(
            `${scope.prefix}files/${file.name}`,
            { ...pin.files[index], bytes: file.bytes },
            { versionId: file.versionId, capture: false },
          );
        }
        await authorize(beforeReturn);
        return describeNativePackageArchiveReceipt(
          {
            schemaVersion: 1,
            materializationId: pin.materializationId,
            manifest: {
              versionId: committed.versionId,
              sha256: committed.sha256,
              bytes: committed.length,
            },
          },
          pin.materializationId,
        );
      } catch (error) {
        throw safeFailure(error);
      }
    },

    async restore({
      projectId,
      sourceId,
      pin: expectedPin,
      attestation,
      materializationId,
      receipt,
      cacheDirectory,
      beforeMaterialize,
    } = {}) {
      let stage;
      try {
        if (typeof beforeMaterialize !== 'function' || !absolute(cacheDirectory)) fail('invalid');
        const pin = describe(expectedPin, attestation);
        const scope = scopeFor(projectId, sourceId, pin);
        if (materializationId !== pin.materializationId) fail('invalid');
        const pinnedReceipt = describeNativePackageArchiveReceipt(receipt, materializationId);
        const committed = await get(
          `${scope.prefix}manifest.json`,
          { ...pinnedReceipt.manifest, limit: RECORD_BYTES },
          { versionId: pinnedReceipt.manifest.versionId, missing: 'not_found' },
        );
        const manifest = parseManifest(committed.bytes, scope, pin);
        stage = await ownedStage();
        for (const [index, file] of manifest.files.entries()) {
          const stored = await get(
            `${scope.prefix}files/${file.name}`,
            { ...pin.files[index], bytes: file.bytes },
            { versionId: file.versionId },
          );
          await writeFile(join(stage, file.name), stored.bytes, { flag: 'wx', mode: 0o600 });
        }
        await authorize(beforeMaterialize);
        let loaded;
        try {
          loaded = await materialize({
            releaseDirectory: stage,
            cacheDirectory,
            pin: packagePin(pin),
            attestation: pin.attestation,
          });
          if (
            loaded?.materializationId !== pin.materializationId ||
            !samePin(describe(loaded?.package, loaded?.attestation), pin)
          )
            fail('corrupt');
        } catch (error) {
          if (error instanceof NativePackageArchiveError) throw error;
          if (error?.code === 'native_package_busy') fail('busy');
          if (error instanceof NativePackageError) fail('corrupt');
          fail('unavailable');
        }
        return loaded;
      } catch (error) {
        throw safeFailure(error);
      } finally {
        await cleanup(stage);
      }
    },
  });
};
