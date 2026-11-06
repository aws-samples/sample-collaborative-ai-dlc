import { createHash, randomUUID } from 'node:crypto';
import { GetObjectCommand, PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { readAttachmentBytes } from '../shared/attachment-bytes.js';
import { createAttachmentIntake } from '../shared/intent-attachment-intake.js';
import {
  createTrackerAttachmentImporter,
  createTrackerUploadSigner,
} from '../shared/intent-tracker-attachment-import.js';
import {
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  attachmentCapacityError,
  attachmentStagingKey,
  validateAttachmentDescriptor,
} from '../shared/intent-attachments.js';
import {
  nativeDraftInputs,
  nativeInputStorageId,
  inputSource,
  inputFailure,
  publicInputAttachment,
} from '../shared/native-inputs.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const operations = {
  source: ['applicationSource'],
  tracker: ['bindingId', 'resourceId'],
  discover: [],
  import: ['attachmentId'],
  'exclude-import': ['attachmentId'],
  upload: ['attachmentId', 'filename', 'mimeType', 'size', 'sha256'],
  complete: ['attachmentId'],
  remove: ['attachmentId'],
  'clear-tracker': [],
};
export const nativeInputRequest = (value) => {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(operations, value.operation) ||
    !Number.isSafeInteger(value.expectedRevision) ||
    value.expectedRevision < 0 ||
    Object.keys(value).length !== operations[value.operation].length + 2 ||
    !operations[value.operation].every((key) => Object.hasOwn(value, key))
  )
    throw inputFailure();
  if (['upload', 'complete', 'remove'].includes(value.operation) && !UUID.test(value.attachmentId))
    throw inputFailure();
  if (
    ['import', 'exclude-import'].includes(value.operation) &&
    (typeof value.attachmentId !== 'string' ||
      !/^(?:[a-f0-9]{64}|[1-9]\d{0,63})$/.test(value.attachmentId))
  )
    throw inputFailure();
  if (value.operation === 'source') {
    if (value.applicationSource === null) throw inputFailure();
    inputSource(value.applicationSource);
  }
  if (
    value.operation === 'tracker' &&
    [value.bindingId, value.resourceId].some(
      (v) =>
        typeof v !== 'string' ||
        !v.trim() ||
        Buffer.byteLength(v) > 256 ||
        [...v].some((character) => character.codePointAt(0) < 32 || character === '\x7f'),
    )
  )
    throw inputFailure();
  if (
    value.operation === 'upload' &&
    (!validateAttachmentDescriptor(value).value || !/^[a-f0-9]{64}$/.test(value.sha256))
  )
    throw inputFailure();
  return structuredClone(value);
};
// The bound stream is read before promotion; no unversioned or oversized object
// can become an admitted attachment even if a presigned upload is reused.
export const inspectNativeUpload = async ({ allocation, source, key, s3, bucket }) => {
  const object = await s3.send(
    new GetObjectCommand({ Bucket: bucket, Key: key, VersionId: source.versionId }),
  );
  try {
    const { sha256 } = await readAttachmentBytes(object.Body, allocation);
    return { sha256 };
  } catch {
    throw inputFailure();
  }
};
const safeImportedFile = (file) => {
  const result = { ...file };
  if (file.source) {
    // Provider transfer URLs are not model input or public provenance.
    const { attachmentUrl: _url, ...source } = file.source;
    result.source = source;
  }
  return result;
};
export const createNativeInputApi = ({
  store,
  executionStore,
  s3,
  bucket,
  accountId,
  invokeTracker,
  signUpload = (key, mimeType) =>
    getSignedUrl(
      s3,
      new PutObjectCommand({
        Bucket: bucket,
        Key: key,
        ContentType: mimeType,
        ExpectedBucketOwner: accountId,
      }),
      { expiresIn: ATTACHMENT_UPLOAD_TTL_SECONDS },
    ),
  trackerUpload = createTrackerUploadSigner({ expectedBucketOwner: accountId }),
  now = Date.now,
}) => {
  if (!/^[0-9]{12}$/.test(accountId ?? '')) throw inputFailure('UNAVAILABLE');
  const storage = {
    send: (command) =>
      s3.send(
        new command.constructor({
          ...command.input,
          ExpectedBucketOwner: accountId,
          ...(command.input.CopySource ? { ExpectedSourceBucketOwner: accountId } : {}),
        }),
      ),
  };
  const handle = async ({ row, identity, actorId, input, recheck }) => {
    let inputs = nativeDraftInputs(row);
    if (inputs.revision !== input.expectedRevision) throw inputFailure('CONFLICT');
    if (await executionStore.get(identity)) throw inputFailure('CONFLICT');
    const storageId = nativeInputStorageId(row);
    let selectionId;
    const save = async (next, expectedRevision = inputs.revision) => {
      await recheck(row);
      row = await store.saveInputs({ ...identity, expectedRevision, inputs: next });
      inputs = nativeDraftInputs(row);
      return row;
    };
    const meta = (draft) => {
      const state = nativeDraftInputs(draft);
      return {
        executionId: storageId,
        projectId: row.projectId,
        status: 'DRAFT',
        source: state.source,
        attachmentRevision: state.revision,
        attachments: state.attachments,
        pendingAttachmentUploads: state.pendingAttachmentUploads,
      };
    };
    const adapter = {
      async getExecution(id) {
        if (id !== storageId) throw inputFailure();
        await recheck(row);
        const current = await store.get(identity);
        return {
          ...meta(current),
          status: (await executionStore.get(identity)) ? 'LOCKED' : 'DRAFT',
        };
      },
      async updateExecution(patch) {
        if (patch.executionId !== storageId || patch.fromStatus !== 'DRAFT') throw inputFailure();
        const current = await store.get(identity);
        const state = nativeDraftInputs(current);
        if (selectionId && !state.importSelections.some((item) => item.id === selectionId))
          throw inputFailure('CONFLICT');
        if (state.source?.bindingFingerprint !== inputs.source?.bindingFingerprint)
          throw inputFailure('CONFLICT');
        try {
          const saved = await save(
            {
              ...state,
              attachments: patch.attachments.map(safeImportedFile),
              pendingAttachmentUploads: patch.pendingAttachmentUploads.map(safeImportedFile),
            },
            patch.ifAttachmentRevision,
          );
          return meta(saved);
        } catch (error) {
          if (error.code === 'NATIVE_INPUT_CONFLICT')
            throw Object.assign(new Error('Input revision changed'), {
              name: 'ConditionalCheckFailedException',
            });
          throw error;
        }
      },
    };
    const ingest = createAttachmentIntake({
      store: adapter,
      s3: storage,
      bucket,
      inspect: inspectNativeUpload,
    });
    const importer = createTrackerAttachmentImporter({
      store: adapter,
      s3: storage,
      bucket,
      invokeTracker,
      ingest,
      pendingAttachments: (meta) => meta.pendingAttachmentUploads ?? [],
      uploadUrl: (key) => trackerUpload(bucket, key),
    });
    const requireIdle = () => {
      if (
        inputs.pendingAttachmentUploads.length ||
        inputs.importSelections.some((item) => item.status === 'pending')
      )
        throw inputFailure('PENDING');
    };
    const reserve = async (value, source) => {
      const descriptor = validateAttachmentDescriptor(value);
      if (
        !descriptor.value ||
        attachmentCapacityError(
          {
            ...inputs,
            // Expired selected uploads still block native Start until removed.
            pendingAttachmentUploads: inputs.pendingAttachmentUploads.map((file) => ({
              ...file,
              expiresAt: new Date(now() + 300000).toISOString(),
            })),
          },
          [descriptor.value],
        )
      )
        throw inputFailure('LIMIT');
      const allocation = {
        ...descriptor.value,
        attachmentId: value.attachmentId,
        ...(value.sha256 ? { sha256: value.sha256 } : {}),
        s3Key: attachmentStagingKey(storageId, value.attachmentId, descriptor.value.extension),
        uploadedBy: actorId,
        expiresAt: new Date(now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
        ...(source ? { source } : {}),
      };
      await save({
        ...inputs,
        pendingAttachmentUploads: [...inputs.pendingAttachmentUploads, allocation],
      });
      return allocation;
    };
    const finishImport = async (id, result) => {
      for (let attempt = 0; attempt < 4; attempt += 1) {
        const current = await store.get(identity);
        const state = nativeDraftInputs(current);
        const selection = state.importSelections.find((item) => item.id === id);
        if (!selection) throw inputFailure('CONFLICT');
        try {
          await save(
            {
              ...state,
              importSelections:
                result.status === 'imported'
                  ? state.importSelections.filter((item) => item.id !== id)
                  : state.importSelections.map((item) =>
                      item.id === id
                        ? {
                            id,
                            status: result.status === 'skipped' ? 'skipped' : 'failed',
                            reason:
                              result.reason ||
                              'Import could not be confirmed. Retry or exclude this file.',
                          }
                        : item,
                    ),
            },
            state.revision,
          );
          return;
        } catch (error) {
          if (error.code !== 'NATIVE_INPUT_CONFLICT' || attempt === 3) throw error;
        }
      }
    };
    const actions = {
      source: async () => {
        requireIdle();
        await save({ ...inputs, applicationSource: input.applicationSource });
      },
      tracker: async () => {
        requireIdle();
        // Reserve a revision before the asynchronous provider read. Start cannot
        // race an import that has been selected but not yet downloaded.
        const id = createHash('sha256')
          .update(`issue:${input.bindingId}:${input.resourceId}`)
          .digest('hex');
        selectionId = id;
        await save({
          ...inputs,
          importSelections: [
            ...inputs.importSelections.filter((item) => item.id !== id),
            { id, status: 'pending' },
          ],
        });
        let result;
        try {
          result = await invokeTracker({
            action: 'native-issue-snapshot',
            projectId: row.projectId,
            userId: actorId,
            bindingId: input.bindingId,
            resourceId: input.resourceId,
          });
          if (result.ok !== true) throw inputFailure('ACCESS');
          const bytes = Buffer.from(result.text, 'utf8');
          const allocation = await reserve(
            {
              attachmentId: randomUUID(),
              filename: 'tracker-issue.md',
              mimeType: 'text/markdown',
              size: bytes.length,
              sha256: createHash('sha256').update(bytes).digest('hex'),
            },
            { ...result.source, attachmentId: 'issue-text' },
          );
          const object = await storage.send(
            new PutObjectCommand({
              Bucket: bucket,
              Key: allocation.s3Key,
              ContentType: allocation.mimeType,
              Body: bytes,
            }),
          );
          if (!object.VersionId) throw inputFailure();
          await ingest({
            detail: { object: { key: allocation.s3Key, 'version-id': object.VersionId } },
          });
          const current = nativeDraftInputs(await store.get(identity));
          await save({ ...current, source: result.source }, current.revision);
          await finishImport(id, { status: 'imported' });
        } catch {
          await finishImport(id, {
            status: 'failed',
            reason: 'Issue text could not be imported. Retry or exclude it before Start.',
          });
          throw inputFailure('ACCESS');
        }
      },
      'clear-tracker': async () => {
        requireIdle();
        await save({
          ...inputs,
          source: null,
          attachments: inputs.attachments.filter((file) => !file.source),
          importSelections: [],
        });
      },
      discover: async () => {
        if (!inputs.source) throw inputFailure();
        const discovery = await importer.list(meta(row), actorId);
        await recheck(row);
        return {
          row: await store.get(identity),
          discovery: {
            ...(discovery.attachments
              ? {
                  attachments: discovery.attachments.map(({ id, filename, skipReason }) => ({
                    id,
                    filename,
                    ...(skipReason ? { skipReason } : {}),
                  })),
                }
              : {}),
            ...(discovery.reason ? { reason: discovery.reason } : {}),
          },
        };
      },
      import: async () => {
        if (!inputs.source) throw inputFailure();
        const id = input.attachmentId;
        selectionId = id;
        const existing = inputs.attachments.find(
          (file) =>
            file.source?.attachmentId === id &&
            file.source.bindingId === inputs.source.bindingId &&
            file.source.resourceId === inputs.source.resourceId,
        );
        if (existing)
          return {
            row,
            importResult: { status: 'imported', attachment: publicInputAttachment(existing) },
          };
        if (inputs.importSelections.some((item) => item.id === id && item.status === 'pending'))
          throw inputFailure('PENDING');
        await save({
          ...inputs,
          importSelections: [
            ...inputs.importSelections.filter((item) => item.id !== id),
            { id, status: 'pending' },
          ],
        });
        const result = await importer.importOne(meta(row), actorId, id);
        await finishImport(id, result);
        return {
          row,
          importResult:
            result.status === 'imported'
              ? { status: 'imported', attachment: publicInputAttachment(result.attachment) }
              : result,
        };
      },
      'exclude-import': async () => {
        await save({
          ...inputs,
          importSelections: inputs.importSelections.filter(
            (item) => item.id !== input.attachmentId,
          ),
        });
      },
      upload: async () => {
        const allocation = await reserve(input);
        const url = await signUpload(allocation.s3Key, allocation.mimeType);
        await recheck(row);
        return {
          row,
          upload: { attachmentId: allocation.attachmentId, url, mimeType: allocation.mimeType },
        };
      },
      complete: async () => {
        const allocation = inputs.pendingAttachmentUploads.find(
          (file) => file.attachmentId === input.attachmentId,
        );
        if (!allocation) {
          if (!inputs.attachments.some((file) => file.attachmentId === input.attachmentId))
            throw inputFailure();
        } else {
          await ingest({ detail: { object: { key: allocation.s3Key } } });
          row = await store.get(identity);
          if (
            !nativeDraftInputs(row).attachments.some(
              (file) => file.attachmentId === input.attachmentId,
            )
          )
            throw inputFailure('UNAVAILABLE');
        }
      },
      remove: async () => {
        const file = inputs.attachments.find((item) => item.attachmentId === input.attachmentId);
        await save({
          ...inputs,
          attachments: inputs.attachments.filter(
            (item) => item.attachmentId !== input.attachmentId,
          ),
          pendingAttachmentUploads: inputs.pendingAttachmentUploads.filter(
            (item) => item.attachmentId !== input.attachmentId,
          ),
        });
        if (file)
          await storage
            .send(
              new DeleteObjectCommand({
                Bucket: bucket,
                Key: file.s3Key,
                VersionId: file.s3VersionId,
              }),
            )
            .catch(() => {});
      },
    };
    const result = await actions[input.operation]();
    await recheck(row);
    return result ?? { row };
  };
  return { handle };
};
