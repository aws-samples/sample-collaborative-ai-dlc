// One promotion owner for browser uploads and tracker imports. Stores supply
// draft-only revision CAS; a native adapter additionally fences Start acceptance.
import { HeadObjectCommand, CopyObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { Logger } from '@aws-lambda-powertools/logger';
import { attachmentCommittedKey, validateAttachmentDescriptor } from './intent-attachments.js';
const logger = new Logger({ persistentKeys: { component: 'intent-attachments' } });
const attachmentEventKey = /^intent-attachments\/staging\/([^/]+)\/([^.]+)(\.[a-z0-9]+)$/i;
const ATTACHMENT_PROMOTION_CAS_ATTEMPTS = 4;
export const createAttachmentIntake = ({
  store,
  s3,
  bucket,
  accepts = () => true,
  notify = async () => {},
  inspect = async () => ({}),
}) => {
  return async (event) => {
    const key = event.detail.object.key;
    const match = attachmentEventKey.exec(key);
    if (!match) return;
    const [, intentId, attachmentId] = match;
    const eventVersionId = event.detail.object['version-id'];
    let source;

    for (let attempt = 0; attempt < ATTACHMENT_PROMOTION_CAS_ATTEMPTS; attempt += 1) {
      const meta = await store.getExecution(intentId, { consistentRead: true });
      if (!meta || !accepts(meta)) return;
      if (meta.status !== 'DRAFT') {
        throw new Error(`Attachment upload arrived after intent ${intentId} left DRAFT`);
      }
      // Delayed S3 events must still be able to consume their reservation. Expiry
      // limits allocation and Start, not the backend's durable upload record.
      const pending = Array.isArray(meta.pendingAttachmentUploads)
        ? meta.pendingAttachmentUploads
        : [];
      const allocation = pending.find(
        (attachment) => attachment.attachmentId === attachmentId && attachment.s3Key === key,
      );
      if (!allocation) return;
      const descriptor = validateAttachmentDescriptor(allocation);
      if (!descriptor.value) return;
      if (!source) {
        const head = await s3.send(
          new HeadObjectCommand({
            Bucket: bucket,
            Key: key,
            ...(eventVersionId ? { VersionId: eventVersionId } : {}),
          }),
        );
        if (
          head.ContentType?.toLowerCase().split(';')[0] !== allocation.mimeType ||
          head.ContentLength !== allocation.size ||
          !head.VersionId
        ) {
          throw new Error(`Attachment upload did not match reservation: ${key}`);
        }
        source = { versionId: head.VersionId };
      }

      const current = Array.isArray(meta.attachments) ? meta.attachments : [];
      if (current.some((attachment) => attachment.attachmentId === attachmentId)) {
        await s3
          .send(
            new DeleteObjectCommand({
              Bucket: bucket,
              Key: key,
              VersionId: source.versionId,
            }),
          )
          .catch((error) => logger.error('Attachment staging cleanup failed', error, { key }));
        return;
      }

      const inspected = await inspect({ allocation, source, key, s3, bucket });
      const committedKey = attachmentCommittedKey(
        intentId,
        attachmentId,
        descriptor.value.extension,
      );
      const copy = await s3.send(
        new CopyObjectCommand({
          Bucket: bucket,
          Key: committedKey,
          CopySource: `${bucket}/${key}?versionId=${encodeURIComponent(source.versionId)}`,
        }),
      );
      if (!copy.VersionId) throw new Error(`Attachment promotion was not versioned: ${key}`);
      const committed = {
        ...inspected,
        attachmentId,
        filename: allocation.filename,
        mimeType: allocation.mimeType,
        size: allocation.size,
        s3Key: committedKey,
        s3VersionId: copy.VersionId,
        uploadedBy: allocation.uploadedBy ?? null,
        uploadedAt: new Date().toISOString(),
        ...(allocation.source ? { source: allocation.source } : {}),
      };
      try {
        await store.updateExecution({
          executionId: intentId,
          fromStatus: 'DRAFT',
          ifAttachmentRevision: Number(meta.attachmentRevision ?? 0),
          attachments: [...current, committed],
          pendingAttachmentUploads: pending.filter(
            (attachment) => attachment.attachmentId !== attachmentId,
          ),
        });
      } catch (error) {
        if (error?.name !== 'ConditionalCheckFailedException') throw error;
        await s3.send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: committedKey,
            VersionId: copy.VersionId,
          }),
        );
        if (attempt + 1 === ATTACHMENT_PROMOTION_CAS_ATTEMPTS) throw error;
        continue;
      }
      await notify(intentId, {
        action: 'intent.attachments',
        intentId,
        projectId: meta.projectId,
      }).catch(() => {});
      await s3
        .send(
          new DeleteObjectCommand({
            Bucket: bucket,
            Key: key,
            VersionId: source.versionId,
          }),
        )
        .catch((error) => logger.error('Attachment staging cleanup failed', error, { key }));
      return;
    }
  };
};
