import {
  DeleteObjectCommand,
  DeleteObjectsCommand,
  ListObjectVersionsCommand,
} from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';

const logger = new Logger({ persistentKeys: { component: 'intent-attachments' } });

export {
  MAX_ATTACHMENTS,
  MAX_ATTACHMENT_BYTES,
  MAX_ATTACHMENT_TOTAL_BYTES,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  attachmentStagingKey,
  attachmentCommittedKey,
  validateAttachmentDescriptor,
  activePendingAttachments,
  attachmentCapacityError,
  normalizeImportedAttachment,
} from './attachment-policy.js';

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
