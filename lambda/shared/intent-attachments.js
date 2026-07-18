import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';

export const MAX_ATTACHMENTS = 5;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_ATTACHMENT_TOTAL_BYTES = MAX_ATTACHMENTS * MAX_ATTACHMENT_BYTES;
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 300;

const attachmentTypes = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
  // TODO: docx, pdf, xslx (requires additional libraries and compute to transform into md)
]);

// Builds the short-lived upload object's intent-scoped staging key.
export const attachmentStagingKey = (intentId, attachmentId, extension) =>
  `intent-attachments/staging/${intentId}/${attachmentId}${extension}`;

// Builds the immutable committed object's intent-scoped key.
export const attachmentCommittedKey = (intentId, attachmentId, extension) =>
  `intent-attachments/committed/${intentId}/${attachmentId}${extension}`;

const containsControlCharacter = (value) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0);
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  });

// Validates untrusted browser metadata and returns its normalized storage descriptor.
export const validateAttachmentDescriptor = (raw) => {
  const rawFilename = typeof raw?.filename === 'string' ? raw.filename : '';
  const filename = rawFilename.trim();
  const mimeType = typeof raw?.mimeType === 'string' ? raw.mimeType.toLowerCase().trim() : '';
  const size = Number(raw?.size);
  const dot = filename.lastIndexOf('.');
  const extension = dot > 0 ? filename.slice(dot).toLowerCase() : '';
  const expectedType = attachmentTypes.get(extension);
  if (
    !filename ||
    filename !== rawFilename ||
    filename !== filename.split('/').pop() ||
    filename.includes('\\') ||
    containsControlCharacter(filename) ||
    Buffer.byteLength(filename, 'utf8') > 255
  ) {
    return {
      error:
        'Attachment filename must be at most 255 bytes and contain no control characters or path separators',
    };
  }
  if (!expectedType) return { error: `Unsupported attachment type for "${filename}"` };
  if (mimeType !== expectedType) {
    return { error: `Attachment "${filename}" must use MIME type ${expectedType}` };
  }
  if (!Number.isInteger(size) || size < 1 || size > MAX_ATTACHMENT_BYTES) {
    return { error: `Attachment "${filename}" must be between 1 byte and 5 MB` };
  }
  return { value: { filename, mimeType, size, extension } };
};

// Returns upload reservations that still count against an intent's attachment limits.
export const activePendingAttachments = (meta, now = Date.now()) =>
  (Array.isArray(meta.pendingAttachmentUploads) ? meta.pendingAttachmentUploads : []).filter(
    (attachment) => Date.parse(attachment.expiresAt ?? '') > now,
  );

// Returns durable cleanup tombstones that need an object purge retry.
export const pendingAttachmentDeletions = (meta) =>
  Array.isArray(meta.pendingAttachmentDeletions) ? meta.pendingAttachmentDeletions : [];

// Compares complete immutable attachment identities for idempotent promotion recovery.
export const sameCommittedAttachment = (expected, actual) =>
  actual?.attachmentId === expected.attachmentId &&
  actual.filename === expected.filename &&
  actual.mimeType === expected.mimeType &&
  actual.size === expected.size &&
  actual.s3Key === expected.s3Key &&
  actual.s3VersionId === expected.s3VersionId;

// Reconciles an ambiguous metadata write without deleting versions durable metadata references.
export const reconcileAttachmentPromotionFailure = async ({
  store,
  intentId,
  projectId,
  committed,
  rollback,
}) => {
  let latest;
  try {
    latest = await store.getExecution(intentId);
  } catch (error) {
    return { kind: 'unverified', error };
  }
  const referenced = committed.filter((created) =>
    (latest?.attachments ?? []).some((attachment) => sameCommittedAttachment(created, attachment)),
  );
  if (latest?.projectId === projectId && referenced.length === committed.length) {
    return { kind: 'replayed', latest };
  }
  try {
    await rollback(committed.filter((created) => !referenced.includes(created)));
  } catch (error) {
    return { kind: 'rollback-failed', error };
  }
  return { kind: 'not-replayed', latest };
};

// Creates S3 cleanup operations with the process store needed to clear durable tombstones.
export const createAttachmentCleanupService = ({ s3, store, bucket }) => {
  const purgeObject = async (key) => {
    let KeyMarker;
    let VersionIdMarker;
    do {
      const versions = await s3.send(
        new ListObjectVersionsCommand({ Bucket: bucket, Prefix: key, KeyMarker, VersionIdMarker }),
      );
      const objects = [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]
        .filter((version) => version.Key === key)
        .map((version) => ({ Key: version.Key, VersionId: version.VersionId }));
      if (objects.length) {
        const deleted = await s3.send(
          new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objects } }),
        );
        if (deleted.Errors?.length) {
          throw new Error(`S3 rejected ${deleted.Errors.length} deletion(s) for ${key}`);
        }
      }
      KeyMarker = versions.NextKeyMarker;
      VersionIdMarker = versions.NextVersionIdMarker;
      if (!versions.IsTruncated) break;
    } while (KeyMarker);
  };

  const deleteVersion = async (attachment) => {
    if (!attachment.s3Key || !attachment.s3VersionId) {
      throw new Error('Attachment metadata is missing an object version for rollback');
    }
    await s3.send(
      new DeleteObjectCommand({
        Bucket: bucket,
        Key: attachment.s3Key,
        VersionId: attachment.s3VersionId,
      }),
    );
  };

  const retryPendingDeletions = async (meta) => {
    const pending = pendingAttachmentDeletions(meta);
    if (!pending.length) return meta;
    const remaining = [];
    for (const attachment of pending) {
      try {
        await purgeObject(attachment.s3Key);
      } catch (error) {
        console.error(`Attachment purge retry failed (${attachment.s3Key}):`, error.message);
        remaining.push(attachment);
      }
    }
    if (remaining.length === pending.length) return meta;
    try {
      return await store.updateExecution({
        executionId: meta.executionId,
        ifAttachmentRevision: Number(meta.attachmentRevision ?? 0),
        pendingAttachmentDeletions: remaining,
      });
    } catch (error) {
      console.error(
        `Attachment cleanup tombstone update failed (${meta.executionId}):`,
        error.message,
      );
      return meta;
    }
  };

  return { deleteVersion, retryPendingDeletions };
};
