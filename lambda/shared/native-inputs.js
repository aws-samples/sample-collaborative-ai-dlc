// JSON contract shared by admission and the isolated runtime. Storage and
// provider credentials stay in their existing owners.
import { createHash } from 'node:crypto';
import {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_TOTAL_BYTES,
  attachmentCommittedKey,
  attachmentStagingKey,
  validateAttachmentDescriptor,
} from './attachment-policy.js';
import { workflowSourceIdentity } from './workflow-source-identity.js';
import { canonicalJson } from './workflow-checkpoint.js';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const SHA = /^[a-f0-9]{64}$/;
const plain = (v) => v && typeof v === 'object' && Object.getPrototypeOf(v) === Object.prototype;
const text = (v, max = 512) =>
  typeof v === 'string' &&
  v.length > 0 &&
  Buffer.byteLength(v) <= max &&
  ![...v].some((character) => character.codePointAt(0) < 32 || character === '\x7f');
export const inputFailure = (suffix = 'INVALID') =>
  Object.assign(new Error('Native inputs could not be verified'), {
    code: `NATIVE_INPUT_${suffix}`,
  });
const check = (v) => {
  if (!v) throw inputFailure();
};
export const inputHash = (v) => createHash('sha256').update(canonicalJson(v)).digest('hex');
export const nativeInputStorageId = ({ projectId, executionId }) =>
  `native-${inputHash({ projectId, executionId })}`;
export const inputSource = (value) => {
  if (value === null) return null;
  check(plain(value) && Object.keys(value).length === 2);
  try {
    workflowSourceIdentity(value.provider, value.repository);
  } catch {
    throw inputFailure();
  }
  return { provider: value.provider, repository: value.repository };
};
export const trackerInputSource = (value) => {
  check(
    plain(value) &&
      Object.keys(value).every((key) =>
        ['provider', 'bindingId', 'resourceId', 'bindingFingerprint', 'title'].includes(key),
      ) &&
      ['github-issues', 'gitlab-issues', 'jira-cloud'].includes(value.provider) &&
      text(value.bindingId, 256) &&
      text(value.resourceId, 256) &&
      SHA.test(value.bindingFingerprint) &&
      text(value.title, 1024),
  );
  return structuredClone(value);
};
export const inputAttachment = (file, storageId, pending = false) => {
  check(plain(file) && UUID.test(file.attachmentId));
  const fields = [
    'attachmentId',
    'filename',
    'mimeType',
    'size',
    's3Key',
    'uploadedBy',
    'source',
    'sha256',
    ...(pending ? ['extension', 'expiresAt'] : ['s3VersionId', 'uploadedAt']),
  ];
  check(Object.keys(file).every((key) => fields.includes(key)));
  const descriptor = validateAttachmentDescriptor(file);
  check(descriptor.value);
  check(
    file.s3Key ===
      (pending ? attachmentStagingKey : attachmentCommittedKey)(
        storageId,
        file.attachmentId,
        descriptor.value.extension,
      ),
  );
  if (pending) {
    check(Number.isFinite(Date.parse(file.expiresAt)));
    check(file.sha256 === undefined || SHA.test(file.sha256));
  } else {
    check(text(file.s3VersionId, 1024) && file.s3VersionId !== 'null' && SHA.test(file.sha256));
  }
  if (file.source) {
    const { attachmentId, commentId, ...source } = file.source;
    trackerInputSource(source);
    check(
      text(attachmentId, 256) &&
        (commentId === undefined || commentId === null || text(commentId, 256)),
    );
  }
  return structuredClone(file);
};
export const nativeDraftInputs = (draft) => {
  const value = draft.inputDraft ?? {
    revision: 0,
    applicationSource: draft.request.applicationSource ?? null,
    source: null,
    attachments: [],
    pendingAttachmentUploads: [],
    importSelections: [],
  };
  check(
    plain(value) &&
      Object.keys(value).length === 6 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      value.revision < Number.MAX_SAFE_INTEGER,
  );
  inputSource(value.applicationSource);
  if (value.source !== null) trackerInputSource(value.source);
  const storageId = nativeInputStorageId(draft);
  for (const [key, pending] of [
    ['attachments', false],
    ['pendingAttachmentUploads', true],
  ]) {
    check(Array.isArray(value[key]) && value[key].length <= MAX_ATTACHMENTS);
    value[key].forEach((file) => inputAttachment(file, storageId, pending));
  }
  const all = [...value.attachments, ...value.pendingAttachmentUploads];
  check(
    new Set(all.map((file) => file.attachmentId)).size === all.length &&
      all.length <= MAX_ATTACHMENTS &&
      all.reduce((sum, file) => sum + file.size, 0) <= MAX_ATTACHMENT_TOTAL_BYTES,
  );
  check(
    Array.isArray(value.importSelections) &&
      value.importSelections.length <= MAX_ATTACHMENTS &&
      new Set(value.importSelections.map((selection) => selection?.id)).size ===
        value.importSelections.length,
  );
  for (const selection of value.importSelections) {
    check(
      plain(selection) &&
        Object.keys(selection).every((key) => ['id', 'status', 'reason'].includes(key)) &&
        text(selection.id, 256) &&
        ['pending', 'failed', 'skipped'].includes(selection.status) &&
        (selection.reason === undefined || text(selection.reason, 2048)),
    );
  }
  return structuredClone(value);
};
export const nativeInputSnapshot = (draft, bucket) => {
  const inputs = nativeDraftInputs(draft);
  if (inputs.pendingAttachmentUploads.length || inputs.importSelections.length)
    throw inputFailure('PENDING');
  return nativeExecutionInputs({
    revision: inputs.revision,
    storageId: nativeInputStorageId(draft),
    bucket,
    attachments: inputs.attachments,
    source: inputs.source,
    contentSha256: inputHash({ attachments: inputs.attachments, source: inputs.source }),
  });
};
export const nativeExecutionInputs = (value) => {
  check(
    plain(value) &&
      Object.keys(value).length === 6 &&
      Number.isSafeInteger(value.revision) &&
      value.revision >= 0 &&
      /^native-[a-f0-9]{64}$/.test(value.storageId) &&
      /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(value.bucket) &&
      !value.bucket.includes('..') &&
      Array.isArray(value.attachments) &&
      value.attachments.length <= MAX_ATTACHMENTS,
  );
  value.attachments.forEach((file) => inputAttachment(file, value.storageId));
  check(
    new Set(value.attachments.map((file) => file.attachmentId)).size === value.attachments.length &&
      value.attachments.reduce((sum, file) => sum + file.size, 0) <= MAX_ATTACHMENT_TOTAL_BYTES &&
      value.contentSha256 === inputHash({ attachments: value.attachments, source: value.source }),
  );
  if (value.source !== null) trackerInputSource(value.source);
  return structuredClone(value);
};
export const publicInputAttachment = ({
  attachmentId,
  filename,
  mimeType,
  size,
  sha256,
  source,
}) => ({
  attachmentId,
  filename,
  mimeType,
  size,
  ...(sha256 ? { sha256 } : {}),
  ...(source
    ? {
        source: {
          provider: source.provider,
          bindingId: source.bindingId,
          resourceId: source.resourceId,
          attachmentId: source.attachmentId,
          title: source.title,
        },
      }
    : {}),
});
export const nativeInputView = (draft) => {
  const inputs = nativeDraftInputs(draft);
  return {
    inputRevision: inputs.revision,
    applicationSource: inputs.applicationSource,
    inputs: {
      attachments: inputs.attachments.map(publicInputAttachment),
      pendingUploads: inputs.pendingAttachmentUploads.map(publicInputAttachment),
      imports: inputs.importSelections,
      source: inputs.source
        ? {
            provider: inputs.source.provider,
            bindingId: inputs.source.bindingId,
            resourceId: inputs.source.resourceId,
            title: inputs.source.title,
          }
        : null,
    },
  };
};
