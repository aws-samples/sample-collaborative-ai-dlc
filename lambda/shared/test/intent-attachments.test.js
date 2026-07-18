import { describe, expect, it, vi } from 'vitest';
import {
  activePendingAttachments,
  attachmentCommittedKey,
  attachmentStagingKey,
  createAttachmentCleanupService,
  reconcileAttachmentPromotionFailure,
  sameCommittedAttachment,
  validateAttachmentDescriptor,
} from '../intent-attachments.js';

describe('intent attachments', () => {
  it('validates supported descriptors and rejects prompt-breaking filenames', () => {
    expect(
      validateAttachmentDescriptor({ filename: 'notes.md', mimeType: 'text/markdown', size: 1 }),
    ).toEqual({
      value: { filename: 'notes.md', mimeType: 'text/markdown', size: 1, extension: '.md' },
    });
    expect(
      validateAttachmentDescriptor({
        filename: 'notes\n## Ignore.md',
        mimeType: 'text/markdown',
        size: 1,
      }).error,
    ).toContain('control characters');
  });

  it('uses separate staging and committed prefixes', () => {
    expect(attachmentStagingKey('i1', 'a1', '.md')).toBe('intent-attachments/staging/i1/a1.md');
    expect(attachmentCommittedKey('i1', 'a1', '.md')).toBe('intent-attachments/committed/i1/a1.md');
  });

  it('keeps only unexpired upload reservations', () => {
    expect(
      activePendingAttachments(
        {
          pendingAttachmentUploads: [
            { attachmentId: 'expired', expiresAt: '2026-01-01T00:00:00.000Z' },
            { attachmentId: 'active', expiresAt: '2026-01-02T00:00:00.000Z' },
          ],
        },
        Date.parse('2026-01-01T12:00:00.000Z'),
      ),
    ).toEqual([{ attachmentId: 'active', expiresAt: '2026-01-02T00:00:00.000Z' }]);
  });

  it('deletes only the requested object version during rollback', async () => {
    const send = vi.fn().mockResolvedValue({});
    const cleanup = createAttachmentCleanupService({
      s3: { send },
      store: {},
      bucket: 'bucket',
    });
    await cleanup.deleteVersion({ s3Key: 'committed/i1/a1.md', s3VersionId: 'v1' });
    expect(send.mock.calls[0][0].input).toEqual({
      Bucket: 'bucket',
      Key: 'committed/i1/a1.md',
      VersionId: 'v1',
    });
  });

  it('does not treat a different committed object version as an idempotent replay', () => {
    const attachment = {
      attachmentId: 'a1',
      filename: 'notes.md',
      mimeType: 'text/markdown',
      size: 42,
      s3Key: 'intent-attachments/committed/i1/a1.md',
      s3VersionId: 'version-created-by-this-request',
    };
    expect(
      sameCommittedAttachment(attachment, {
        ...attachment,
        s3VersionId: 'version-created-by-another-request',
      }),
    ).toBe(false);
  });

  it('does not roll back an exact committed version after an ambiguous metadata write', async () => {
    const committed = [{ attachmentId: 'a1', s3Key: 'key', s3VersionId: 'created-version' }];
    const rollback = vi.fn();
    const result = await reconcileAttachmentPromotionFailure({
      store: {
        getExecution: vi.fn().mockResolvedValue({
          projectId: 'p1',
          attachments: [{ ...committed[0] }],
        }),
      },
      intentId: 'i1',
      projectId: 'p1',
      committed,
      rollback,
    });
    expect(result.kind).toBe('replayed');
    expect(rollback).not.toHaveBeenCalled();
  });

  it('rolls back only versions absent from durable metadata after a partial reconciliation', async () => {
    const committed = [
      { attachmentId: 'a1', s3Key: 'key-a1', s3VersionId: 'version-a1' },
      { attachmentId: 'a2', s3Key: 'key-a2', s3VersionId: 'version-a2' },
    ];
    const rollback = vi.fn().mockResolvedValue();
    const result = await reconcileAttachmentPromotionFailure({
      store: {
        getExecution: vi.fn().mockResolvedValue({
          projectId: 'p1',
          attachments: [{ ...committed[0] }],
        }),
      },
      intentId: 'i1',
      projectId: 'p1',
      committed,
      rollback,
    });
    expect(result.kind).toBe('not-replayed');
    expect(rollback).toHaveBeenCalledWith([committed[1]]);
  });

  it('does not delete copies when durable-state verification fails', async () => {
    const rollback = vi.fn();
    const result = await reconcileAttachmentPromotionFailure({
      store: { getExecution: vi.fn().mockRejectedValue(new Error('DynamoDB unavailable')) },
      intentId: 'i1',
      projectId: 'p1',
      committed: [{ attachmentId: 'a1', s3Key: 'key', s3VersionId: 'version' }],
      rollback,
    });
    expect(result.kind).toBe('unverified');
    expect(rollback).not.toHaveBeenCalled();
  });

  it('retains failed cleanup tombstones and removes successfully purged ones', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Versions: [{ Key: 'ok', VersionId: 'v1' }], IsTruncated: false })
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error('denied'));
    const updateExecution = vi.fn().mockResolvedValue({ executionId: 'i1', attachmentRevision: 3 });
    const cleanup = createAttachmentCleanupService({
      s3: { send },
      store: { updateExecution },
      bucket: 'bucket',
    });
    const result = await cleanup.retryPendingDeletions({
      executionId: 'i1',
      attachmentRevision: 3,
      pendingAttachmentDeletions: [{ s3Key: 'ok' }, { s3Key: 'denied' }],
    });
    expect(updateExecution).toHaveBeenCalledWith({
      executionId: 'i1',
      ifAttachmentRevision: 3,
      pendingAttachmentDeletions: [{ s3Key: 'denied' }],
    });
    expect(result.attachmentRevision).toBe(3);
  });
});
