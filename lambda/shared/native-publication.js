// Exact immutable bytes, not execution/approval authority. The controller must
// authorize the current attempt before committing a receipt from this module.
import { createHash } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import { canonicalJson } from './workflow-checkpoint.js';

const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
export const NATIVE_PUBLICATION_LIMITS = Object.freeze({
  files: 1000,
  fileBytes: 32 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  manifestBytes: 1024 * 1024,
});
const fail = () => {
  throw Object.assign(new Error('Native publication could not be verified'), {
    code: 'NATIVE_PUBLICATION_INVALID',
  });
};
const object = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const hash = (v) => createHash('sha256').update(v).digest('hex');
const safeVersion = (v) =>
  typeof v === 'string' && v !== 'null' && /^[A-Za-z0-9._~+/=-]{1,1024}$/.test(v);
const exact = (v, fields) =>
  object(v) && Object.keys(v).length === fields.length && fields.every((f) => Object.hasOwn(v, f));

// Keep the same four-request bound as private checkpoints. A failed inventory
// drains all started operations and never advances to its manifest commit.
const eachFile = async (files, operation) => {
  let next = 0;
  let failed = false;
  let failure;
  await Promise.all(
    Array.from({ length: Math.min(4, files.length) }, async () => {
      while (!failed && next < files.length) {
        const index = next++;
        try {
          await operation(files[index], index);
        } catch (error) {
          if (!failed) {
            failed = true;
            failure = error;
          }
        }
      }
    }),
  );
  if (failed) throw failure;
};

export const nativePublicationScope = (input) => {
  if (
    !object(input) ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/.test(input.projectId ?? '') ||
    !UUID.test(input.executionId ?? '') ||
    !UUID.test(input.attemptId ?? '') ||
    !Number.isSafeInteger(input.epoch) ||
    input.epoch < 1
  )
    fail();
  const { projectId, executionId, attemptId, epoch } = input;
  const scope = { projectId, executionId, attemptId, epoch };
  return {
    ...scope,
    prefix: `native-executions/v1/${hash(canonicalJson({ projectId, executionId }))}/${attemptId}/${epoch}/`,
  };
};

export const nativePublicationPath = (path) => {
  if (
    typeof path !== 'string' ||
    Buffer.byteLength(path) > 1024 ||
    !path ||
    path.startsWith('/') ||
    path.includes('\\') ||
    [...path].some((c) => c.codePointAt(0) < 32 || c === '\x7f') ||
    path.split('/').some((p) => !p || p === '.' || p === '..') ||
    path
      .split('/')
      .some((p) =>
        [
          '.git',
          '.native-control',
          '.native-homes',
          '.claude',
          '.codex',
          '.kiro',
          '.opencode',
        ].includes(p),
      ) ||
    path.endsWith('/steering-token-key') ||
    (path.includes('/.aidlc-engine/') && /(?:lock|mutex|key)(?:\.|$)/.test(path.split('/').at(-1)))
  )
    fail();
  return path;
};

export const nativeFileId = (scope, path) =>
  `nf-${hash(canonicalJson({ projectId: scope.projectId, executionId: scope.executionId, path: nativePublicationPath(path) }))}`;
const fileKey = (scope, file) => `${scope.prefix}files/${file.id}/${file.sha256}`;
const media = (path) =>
  /\.(?:md|markdown)$/i.test(path)
    ? 'text/markdown'
    : /\.(?:json|jsonl)$/i.test(path)
      ? 'application/json'
      : /\.(?:txt|js|jsx|ts|tsx|css|html|yaml|yml|toml|py|sh|gitignore)$/i.test(path)
        ? 'text/plain'
        : /\.(?:png)$/i.test(path)
          ? 'image/png'
          : /\.(?:jpg|jpeg)$/i.test(path)
            ? 'image/jpeg'
            : 'application/octet-stream';

const validateManifest = (value, identity) => {
  const scope = nativePublicationScope(identity);
  if (
    !exact(value, [
      'schemaVersion',
      'scope',
      'packageId',
      'sequence',
      'createdAt',
      'nativeSessionId',
      'outcome',
      'repository',
      'files',
      'question',
      ...(value.schemaVersion === 2 ? ['sourceBaseline'] : []),
    ]) ||
    ![1, 2].includes(value.schemaVersion) ||
    canonicalJson(value.scope) !==
      canonicalJson({
        projectId: scope.projectId,
        executionId: scope.executionId,
        attemptId: scope.attemptId,
        epoch: scope.epoch,
      }) ||
    !/^sha256:[a-f0-9]{64}$/.test(value.packageId ?? '') ||
    !Number.isSafeInteger(value.sequence) ||
    value.sequence < 1 ||
    typeof value.createdAt !== 'string' ||
    !Number.isFinite(Date.parse(value.createdAt)) ||
    !(
      (value.outcome === 'STOPPED' && value.nativeSessionId === null) ||
      (typeof value.nativeSessionId === 'string' &&
        /^[A-Za-z0-9_-]{1,128}$/.test(value.nativeSessionId))
    ) ||
    !['WAITING_FOR_INPUT', 'STOPPED'].includes(value.outcome) ||
    !exact(value.repository, ['commit', 'branch']) ||
    !/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(value.repository.commit ?? '') ||
    typeof value.repository.branch !== 'string' ||
    !value.repository.branch ||
    !Array.isArray(value.files) ||
    value.files.length > NATIVE_PUBLICATION_LIMITS.files
  )
    fail();
  if (value.schemaVersion === 2) {
    const baseline = value.sourceBaseline;
    const absent =
      exact(baseline, ['unavailable']) &&
      ['file_policy', 'snapshot_limit'].includes(baseline.unavailable);
    if (
      !absent &&
      (!exact(baseline, ['epoch', 'receipt']) ||
        !Number.isSafeInteger(baseline.epoch) ||
        baseline.epoch < 1 ||
        baseline.epoch > scope.epoch ||
        !object(baseline.receipt))
    )
      fail();
  }
  const paths = new Set();
  let total = 0;
  for (const file of value.files) {
    if (
      !exact(file, ['id', 'path', 'bytes', 'sha256', 'role', 'mediaType', 'object']) ||
      paths.has(nativePublicationPath(file.path)) ||
      file.id !== nativeFileId(scope, file.path) ||
      !Number.isSafeInteger(file.bytes) ||
      file.bytes < 0 ||
      file.bytes > NATIVE_PUBLICATION_LIMITS.fileBytes ||
      !SHA.test(file.sha256 ?? '') ||
      !['artifact', 'code', 'state', 'question'].includes(file.role) ||
      file.mediaType !== media(file.path) ||
      !exact(file.object, ['key', 'versionId']) ||
      file.object.key !== fileKey(scope, file) ||
      !safeVersion(file.object.versionId)
    )
      fail();
    paths.add(file.path);
    total += file.bytes;
  }
  if (total > NATIVE_PUBLICATION_LIMITS.totalBytes) fail();
  if (value.question !== null) {
    if (!exact(value.question, ['fileId', 'path', 'sha256'])) fail();
    const file = value.files.find((f) => f.id === value.question.fileId);
    if (
      !file ||
      file.path !== value.question.path ||
      file.sha256 !== value.question.sha256 ||
      file.role !== 'question'
    )
      fail();
  }
  if ((value.outcome === 'WAITING_FOR_INPUT') !== Boolean(value.question)) fail();
  return structuredClone(value);
};

export const createNativePublications = ({
  s3,
  bucket,
  accountId,
  now = () => new Date().toISOString(),
}) => {
  if (
    !s3?.send ||
    !/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket ?? '') ||
    !/^\d{12}$/.test(accountId ?? '')
  )
    fail();
  const base = { Bucket: bucket, ExpectedBucketOwner: accountId };
  const put = async (key, data, contentType) => {
    const response = await s3.send(
      new PutObjectCommand({
        ...base,
        Key: key,
        Body: data,
        ContentType: contentType,
        ChecksumSHA256: createHash('sha256').update(data).digest('base64'),
      }),
      { abortSignal: AbortSignal.timeout(120000) },
    );
    if (!safeVersion(response.VersionId)) fail();
    return { key, versionId: response.VersionId };
  };
  const get = async (pointer, maxBytes, signal, verifySha256 = null) => {
    if (!object(pointer) || typeof pointer.key !== 'string' || !safeVersion(pointer.versionId))
      fail();
    const deadline = signal
      ? AbortSignal.any([signal, AbortSignal.timeout(120000)])
      : AbortSignal.timeout(120000);
    deadline.throwIfAborted();
    const response = await s3.send(
      new GetObjectCommand({
        ...base,
        Key: pointer.key,
        VersionId: pointer.versionId,
      }),
      { abortSignal: deadline },
    );
    if (
      response.VersionId !== pointer.versionId ||
      !Number.isSafeInteger(response.ContentLength) ||
      response.ContentLength < 0 ||
      response.ContentLength > maxBytes ||
      (verifySha256 !== null && response.ContentLength !== maxBytes)
    ) {
      response.Body?.destroy?.();
      fail();
    }
    // Admission needs an exact digest, not four accumulated source files.
    // Member file downloads and manifest decoding still collect their bytes.
    const chunks = verifySha256 === null ? [] : null;
    const digest = verifySha256 === null ? null : createHash('sha256');
    let count = 0;
    const abort = () => response.Body?.destroy?.(deadline.reason);
    deadline.addEventListener('abort', abort, { once: true });
    try {
      deadline.throwIfAborted();
      for await (const part of response.Body) {
        deadline.throwIfAborted();
        count += part.length;
        if (count > maxBytes || count > response.ContentLength) fail();
        if (chunks) chunks.push(Buffer.from(part));
        else digest.update(part);
      }
    } finally {
      deadline.removeEventListener('abort', abort);
      response.Body?.destroy?.();
    }
    if (count !== response.ContentLength) fail();
    if (digest && digest.digest('hex') !== verifySha256) fail();
    return chunks ? Buffer.concat(chunks) : null;
  };
  const verifyFile = async (identity, manifest, fileId, { signal } = {}) => {
    const checked = validateManifest(manifest, identity);
    const file = checked.files.find((f) => f.id === fileId);
    if (!file) fail();
    const bytes = await get(file.object, file.bytes, signal);
    if (bytes.length !== file.bytes || hash(bytes) !== file.sha256) fail();
    return { file, bytes };
  };
  const api = {
    async write({
      identity,
      packageId,
      nativeSessionId,
      outcome,
      repository,
      files,
      questionPath = null,
      sequence = 1,
      sourceBaseline,
    }) {
      const scope = nativePublicationScope(identity);
      if (!Array.isArray(files) || files.length > NATIVE_PUBLICATION_LIMITS.files) fail();
      let total = 0;
      const normalized = files.map((file) => {
        nativePublicationPath(file.path);
        if (!Buffer.isBuffer(file.content)) fail();
        total += file.content.length;
        if (
          file.content.length > NATIVE_PUBLICATION_LIMITS.fileBytes ||
          total > NATIVE_PUBLICATION_LIMITS.totalBytes
        )
          fail();
        return {
          id: nativeFileId(scope, file.path),
          path: file.path,
          bytes: file.content.length,
          sha256: hash(file.content),
          role: file.role,
          mediaType: media(file.path),
          content: Buffer.from(file.content),
        };
      });
      if (new Set(normalized.map((f) => f.path)).size !== normalized.length) fail();
      // Validate all metadata before the first write. Placeholder object versions
      // are only used in this prospective validation, never published or returned.
      const manifest = validateManifest(
        {
          schemaVersion: sourceBaseline ? 2 : 1,
          ...(sourceBaseline ? { sourceBaseline } : {}),
          scope: {
            projectId: scope.projectId,
            executionId: scope.executionId,
            attemptId: scope.attemptId,
            epoch: scope.epoch,
          },
          packageId,
          sequence,
          createdAt: now(),
          nativeSessionId,
          outcome,
          repository,
          files: normalized.map(({ content: _content, ...file }) => ({
            ...file,
            object: { key: fileKey(scope, file), versionId: 'prospective' },
          })),
          question: questionPath
            ? (() => {
                const f = normalized.find((entry) => entry.path === questionPath);
                return f ? { fileId: f.id, path: f.path, sha256: f.sha256 } : {};
              })()
            : null,
        },
        identity,
      );
      await eachFile(normalized, async (file, index) => {
        manifest.files[index].object = await put(
          fileKey(scope, file),
          file.content,
          file.mediaType,
        );
      });
      const data = Buffer.from(canonicalJson(manifest));
      if (data.length > NATIVE_PUBLICATION_LIMITS.manifestBytes) fail();
      const sha256 = hash(data);
      const pointer = await put(
        `${scope.prefix}manifests/${sha256}.json`,
        data,
        'application/json',
      );
      return {
        id: sha256,
        sequence: manifest.sequence,
        manifest: { ...pointer, sha256, bytes: data.length },
        question: manifest.question
          ? { path: manifest.question.path, sha256: manifest.question.sha256 }
          : null,
        outcome,
        nativeSessionId,
        filesCount: normalized.length,
      };
    },
    async read(identity, receipt, { verifyFiles = false } = {}) {
      const scope = nativePublicationScope(identity);
      const pointer = receipt?.manifest;
      if (
        !exact(pointer, ['key', 'versionId', 'sha256', 'bytes']) ||
        !SHA.test(pointer.sha256 ?? '') ||
        pointer.key !== `${scope.prefix}manifests/${pointer.sha256}.json` ||
        receipt.id !== pointer.sha256 ||
        !Number.isSafeInteger(pointer.bytes) ||
        pointer.bytes < 1 ||
        pointer.bytes > NATIVE_PUBLICATION_LIMITS.manifestBytes
      )
        fail();
      const bytes = await get(pointer, pointer.bytes);
      if (bytes.length !== pointer.bytes || hash(bytes) !== pointer.sha256) fail();
      let manifest;
      try {
        manifest = validateManifest(
          JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          identity,
        );
      } catch {
        fail();
      }
      if (
        receipt.sequence !== manifest.sequence ||
        receipt.nativeSessionId !== manifest.nativeSessionId ||
        receipt.outcome !== manifest.outcome ||
        receipt.filesCount !== manifest.files.length ||
        canonicalJson(receipt.question) !==
          canonicalJson(
            manifest.question
              ? {
                  path: manifest.question.path,
                  sha256: manifest.question.sha256,
                }
              : null,
          )
      )
        fail();
      // The manifest was just fully validated and is locally owned. Re-running
      // that O(files) validation for every file made admission quadratic.
      if (verifyFiles)
        await eachFile(manifest.files, (file) =>
          get(file.object, file.bytes, undefined, file.sha256),
        );
      return manifest;
    },
    file: verifyFile,
    async source(identity, manifest, { verifyFiles = false } = {}) {
      const checked = validateManifest(manifest, identity);
      if (!checked.sourceBaseline || checked.sourceBaseline.unavailable) return null;
      const sourceIdentity = { ...identity, epoch: checked.sourceBaseline.epoch };
      const baseline = await api.read(sourceIdentity, checked.sourceBaseline.receipt, {
        verifyFiles,
      });
      if (
        baseline.schemaVersion !== 1 ||
        baseline.sequence !== 1 ||
        baseline.nativeSessionId !== null ||
        baseline.outcome !== 'STOPPED' ||
        baseline.packageId !== checked.packageId ||
        canonicalJson(baseline.repository) !== canonicalJson(checked.repository)
      )
        fail();
      return {
        identity: sourceIdentity,
        receipt: checked.sourceBaseline.receipt,
        manifest: baseline,
      };
    },
  };
  return Object.freeze(api);
};

export const nativePublicationView = (receipt, manifest, projectionStatus) => ({
  id: receipt.id,
  sequence: manifest.sequence,
  createdAt: manifest.createdAt,
  files: manifest.files.map(({ object: _object, ...file }) => file),
  question: manifest.question,
  projectionStatus,
});
