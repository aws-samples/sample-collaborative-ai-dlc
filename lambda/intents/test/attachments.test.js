import { describe, expect, it, vi } from 'vitest';
import {
  activePendingAttachments,
  attachmentCommittedKey,
  attachmentStagingKey,
  createAttachmentCleanupService,
  validateAttachmentDescriptor,
} from '../attachments.js';

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

  it.each([
    ['pdf', 'application/pdf'],
    ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
    ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
  ])('accepts %s documents while enforcing MIME and size limits', (extension, mimeType) => {
    const descriptor = {
      filename: `reference.${extension.toUpperCase()}`,
      mimeType,
      size: 5 * 1024 * 1024,
    };
    expect(validateAttachmentDescriptor(descriptor)).toEqual({
      value: { ...descriptor, extension: `.${extension}` },
    });
    expect(
      validateAttachmentDescriptor({ ...descriptor, mimeType: 'application/octet-stream' }).error,
    ).toContain(`must use MIME type ${mimeType}`);
    for (const size of [0, descriptor.size + 1]) {
      expect(validateAttachmentDescriptor({ ...descriptor, size }).error).toContain(
        'between 1 byte and 5 MB',
      );
    }
  });

  it.each(['doc', 'xls', 'docm', 'xlsm'])('continues to reject .%s attachments', (extension) => {
    expect(
      validateAttachmentDescriptor({
        filename: `reference.${extension}`,
        mimeType: 'application/octet-stream',
        size: 10,
      }).error,
    ).toContain('Unsupported attachment type');
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
