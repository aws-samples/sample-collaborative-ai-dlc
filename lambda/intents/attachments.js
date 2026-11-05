import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'intent-attachments' } });

export const MAX_ATTACHMENTS = 50;
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024; // 5MB
export const MAX_ATTACHMENT_TOTAL_BYTES = 25 * 1024 * 1024; // 25MB across all files
export const ATTACHMENT_UPLOAD_TTL_SECONDS = 300;

const attachmentTypes = new Map([
  ['.txt', 'text/plain'],
  ['.md', 'text/markdown'],
  ['.csv', 'text/csv'],
  ['.html', 'text/html'],
  ['.pdf', 'application/pdf'],
  ['.docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
  ['.xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.svg', 'image/svg+xml'],
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

export const attachmentCapacityError = (meta, incoming) => {
  const existing = [...(meta.attachments || []), ...activePendingAttachments(meta)];
  if (existing.length + incoming.length > MAX_ATTACHMENTS) {
    return `Maximum ${MAX_ATTACHMENTS} attachments per intent`;
  }
  if (
    [...existing, ...incoming].reduce((sum, file) => sum + Number(file.size || 0), 0) >
    MAX_ATTACHMENT_TOTAL_BYTES
  ) {
    return 'Attachments cannot exceed 25 MB in total';
  }
  return null;
};

export const normalizeImportedAttachment = (raw) => {
  let filename = raw.filename || '';
  const extension = filename.includes('.') ? `.${filename.split('.').pop().toLowerCase()}` : '';
  let mimeType = raw.mimeType;
  if (
    attachmentTypes.has(extension) &&
    ['application/octet-stream', 'binary/octet-stream', 'application/zip'].includes(mimeType)
  ) {
    mimeType = attachmentTypes.get(extension);
  }
  if (!extension) {
    const inferred = [...attachmentTypes].find(([, type]) => type === mimeType)?.[0];
    // An HTML login/error page must not become an attachment when a provider
    // protects an extensionless image URL with a browser session.
    if (inferred && inferred !== '.html') filename += inferred;
  }
  return validateAttachmentDescriptor({ filename, mimeType, size: raw.size });
};

// Returns durable cleanup tombstones that need an object purge retry.
export const pendingAttachmentDeletions = (meta) =>
  Array.isArray(meta.pendingAttachmentDeletions) ? meta.pendingAttachmentDeletions : [];

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
        logger.error('Attachment purge retry failed', error, { s3Key: attachment.s3Key });
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
      logger.error('Attachment cleanup tombstone update failed', error, {
        executionId: meta.executionId,
      });
      return meta;
    }
  };

  return { deleteVersion, retryPendingDeletions };
};
