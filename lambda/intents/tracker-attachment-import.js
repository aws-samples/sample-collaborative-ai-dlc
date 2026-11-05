import { randomUUID } from 'node:crypto';
import {
  S3Client,
  PutObjectCommand,
  CopyObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import {
  MAX_ATTACHMENT_BYTES,
  ATTACHMENT_UPLOAD_TTL_SECONDS,
  activePendingAttachments,
  attachmentCapacityError,
  attachmentStagingKey,
  normalizeImportedAttachment,
} from './attachments.js';

// The bytes arrive later from the provider. The SDK's default checksum
// calculation would sign the checksum of an empty body into this upload URL.
export const createTrackerUploadSigner = (options = {}) => {
  const client = new S3Client({ ...options, requestChecksumCalculation: 'WHEN_REQUIRED' });
  return (bucket, key) =>
    getSignedUrl(client, new PutObjectCommand({ Bucket: bucket, Key: key }), {
      expiresIn: ATTACHMENT_UPLOAD_TTL_SECONDS,
    });
};

export const createTrackerAttachmentImporter = ({
  store,
  s3,
  bucket,
  invokeTracker,
  uploadUrl,
  ingest,
}) => {
  const request = (meta, userId, options = {}) =>
    invokeTracker({
      action: 'issue-attachments',
      projectId: meta.projectId,
      bindingId: meta.source.bindingId,
      resourceId: meta.source.resourceId,
      userId,
      ...options,
    });
  const matchesSource = (meta, file, id) =>
    file.source?.attachmentId === id &&
    file.source.bindingId === meta.source.bindingId &&
    file.source.resourceId === meta.source.resourceId;
  const list = async (meta, userId) => {
    const discovery = await request(meta, userId);
    if (!discovery.attachments) return discovery;
    return {
      ...discovery,
      attachments: discovery.attachments.filter(
        (candidate) => !meta.attachments?.some((file) => matchesSource(meta, file, candidate.id)),
      ),
    };
  };

  const importOne = async (meta, userId, id) => {
    const intentId = meta.executionId;
    const isImportedFile = (file) => matchesSource(meta, file, id);
    const attachmentId = randomUUID();
    const existing = meta.attachments?.find(isImportedFile);
    if (existing) return { status: 'imported', attachment: existing };
    // This temporary prefix is covered by staging's existing expiration rule
    // and intentionally does not match the upload-event promotion key pattern.
    const temporaryKey = `intent-attachments/staging/${intentId}/imports/${randomUUID()}`;
    let temporaryVersion;
    let allocation;
    try {
      const downloaded = await request(meta, userId, {
        attachmentId: id,
        uploadUrl: await uploadUrl(temporaryKey),
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      if (downloaded.status !== 'downloaded') return downloaded;
      temporaryVersion = downloaded.versionId;
      const descriptor = normalizeImportedAttachment(downloaded);
      if (descriptor.error) return { status: 'skipped', reason: descriptor.error };
      const source = {
        ...meta.source,
        attachmentId: id,
        attachmentUrl: downloaded.source.url,
        commentId: downloaded.source.commentId ?? null,
      };
      for (let attempt = 0; attempt < 4; attempt += 1) {
        meta = await store.getExecution(intentId);
        const committed = meta?.attachments?.find(isImportedFile);
        if (committed) return { status: 'imported', attachment: committed };
        if (meta?.status !== 'DRAFT')
          return { status: 'failed', reason: 'The intent is no longer a draft.' };
        const pending = activePendingAttachments(meta);
        if (pending.some(isImportedFile)) {
          return {
            status: 'failed',
            reason: 'This attachment is already being imported. Refresh and retry.',
          };
        }
        const limit = attachmentCapacityError(meta, [descriptor.value]);
        if (limit) return { status: 'skipped', reason: limit };
        const reservation = {
          attachmentId,
          ...descriptor.value,
          source,
          s3Key: attachmentStagingKey(intentId, attachmentId, descriptor.value.extension),
          uploadedBy: userId,
          expiresAt: new Date(Date.now() + ATTACHMENT_UPLOAD_TTL_SECONDS * 1000).toISOString(),
        };
        try {
          await store.updateExecution({
            executionId: intentId,
            fromStatus: 'DRAFT',
            ifAttachmentRevision: Number(meta.attachmentRevision || 0),
            attachments: meta.attachments || [],
            pendingAttachmentUploads: [...pending, reservation],
          });
          allocation = reservation;
          break;
        } catch (error) {
          if (error.name !== 'ConditionalCheckFailedException' || attempt === 3) throw error;
        }
      }
      const staged = await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: allocation.s3Key,
          CopySource: `${bucket}/${temporaryKey}?versionId=${encodeURIComponent(temporaryVersion)}`,
          MetadataDirective: 'REPLACE',
          ContentType: allocation.mimeType,
        }),
      );
      if (!staged.VersionId) throw new Error('Missing staging object version');
      await ingest({
        detail: { object: { key: allocation.s3Key, 'version-id': staged.VersionId } },
      });
      const final = await store.getExecution(intentId);
      const attachment = final?.attachments?.find((file) => file.attachmentId === attachmentId);
      if (!attachment) throw new Error('Attachment was not committed');
      return { status: 'imported', attachment };
    } catch {
      // Release our failed reservation so it does not block Start. Committed
      // attachments are never removed; a concurrent S3 event may have won.
      for (let attempt = 0; attempt < 4; attempt += 1) {
        if (!allocation) break;
        const current = await store.getExecution(intentId);
        const committed = current?.attachments?.find((file) => file.attachmentId === attachmentId);
        if (committed) return { status: 'imported', attachment: committed };
        if (!current || current.status !== 'DRAFT') break;
        try {
          await store.updateExecution({
            executionId: intentId,
            fromStatus: 'DRAFT',
            ifAttachmentRevision: Number(current.attachmentRevision || 0),
            attachments: current.attachments || [],
            pendingAttachmentUploads: (current.pendingAttachmentUploads || []).filter(
              (file) => file.attachmentId !== attachmentId,
            ),
          });
          break;
        } catch {
          // Best effort; the existing reservation expiry is the recovery path.
        }
      }
      return {
        status: 'failed',
        reason: 'The attachment could not be imported. Retry from the draft.',
      };
    } finally {
      if (temporaryVersion) {
        await s3
          .send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: temporaryKey,
              VersionId: temporaryVersion,
            }),
          )
          .catch(() => {});
      }
    }
  };
  return { list, importOne };
};
