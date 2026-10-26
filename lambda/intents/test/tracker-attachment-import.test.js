import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createTrackerAttachmentImporter,
  createTrackerUploadSigner,
} from '../tracker-attachment-import.js';
import { normalizeImportedAttachment } from '../attachments.js';

describe('tracker import through intent attachments', () => {
  let meta, store, s3, invokeTracker, ingest, importer;
  beforeEach(() => {
    meta = {
      executionId: 'intent-1',
      projectId: 'project-1',
      status: 'DRAFT',
      attachmentRevision: 0,
      attachments: [],
      pendingAttachmentUploads: [],
      source: {
        bindingId: 'binding-1',
        resourceId: '42',
        provider: 'github-issues',
        resourceUrl: 'https://github.com/acme/app/issues/42',
      },
    };
    store = {
      getExecution: vi.fn(async () => structuredClone(meta)),
      updateExecution: vi.fn(async (input) => {
        if (
          input.fromStatus !== meta.status ||
          input.ifAttachmentRevision !== meta.attachmentRevision
        ) {
          throw Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' });
        }
        Object.assign(meta, input);
        if (input.attachments !== undefined) meta.attachmentRevision += 1;
      }),
    };
    s3 = { send: vi.fn(async () => ({ VersionId: 'staged-v1' })) };
    invokeTracker = vi.fn(async () => ({
      status: 'downloaded',
      filename: 'design.pdf',
      mimeType: 'application/pdf',
      size: 100,
      versionId: 'download-v1',
      source: { url: 'https://github.com/user-attachments/files/123/design.pdf', commentId: 'c1' },
    }));
    ingest = vi.fn(async () => {
      meta.attachments.push({ ...meta.pendingAttachmentUploads[0], s3VersionId: 'committed-v1' });
      meta.pendingAttachmentUploads = [];
    });
    importer = createTrackerAttachmentImporter({
      store,
      s3,
      bucket: 'artifacts',
      invokeTracker,
      ingest,
      uploadUrl: vi.fn(async () => 'https://artifacts.s3.amazonaws.com/signed'),
    });
  });

  it('promotes original files through the existing pipeline with issue/comment provenance', async () => {
    const result = await importer.importOne(meta, 'user-1', 'asset-1');
    expect(result.status).toBe('imported');
    expect(result.attachment.source).toMatchObject({
      ...meta.source,
      attachmentId: 'asset-1',
      commentId: 'c1',
    });
    expect(invokeTracker).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: 'project-1',
        bindingId: 'binding-1',
        resourceId: '42',
        userId: 'user-1',
        maxBytes: 5 * 1024 * 1024,
      }),
    );
    expect(ingest).toHaveBeenCalledWith(
      expect.objectContaining({
        detail: { object: { key: result.attachment.s3Key, 'version-id': 'staged-v1' } },
      }),
    );
    expect(s3.send.mock.calls.at(-1)[0].input).toMatchObject({ VersionId: 'download-v1' });
  });

  it('deduplicates retries by source identity without downloading again', async () => {
    await importer.importOne(meta, 'user-1', 'asset-1');
    await importer.importOne(meta, 'user-1', 'asset-1');
    expect(invokeTracker).toHaveBeenCalledTimes(1);
    expect(meta.attachments).toHaveLength(1);
  });

  it('lists only missing files using persisted source identity, not filenames', async () => {
    await importer.importOne(meta, 'user-1', 'asset-1');
    meta.attachments.push(
      { filename: 'design.pdf' },
      { source: { ...meta.source, bindingId: 'another-binding', attachmentId: 'asset-2' } },
      { source: { ...meta.source, resourceId: 'another-issue', attachmentId: 'asset-3' } },
    );
    const remaining = [
      { id: 'asset-2', filename: 'design.pdf' },
      { id: 'asset-3', filename: 'other.pdf' },
      { id: 'asset-4', filename: 'external.pdf', skipReason: 'External file link' },
    ];
    invokeTracker.mockResolvedValue({
      attachments: [{ id: 'asset-1', filename: 'renamed.pdf' }, ...remaining],
    });

    expect(await importer.list(structuredClone(meta), 'user-1')).toEqual({
      attachments: remaining,
    });
  });

  it('returns no candidates after all files are imported, but offers removed files again', async () => {
    await importer.importOne(meta, 'user-1', 'asset-1');
    const candidate = { id: 'asset-1', filename: 'design.pdf' };
    invokeTracker.mockResolvedValue({ attachments: [candidate] });
    expect(await importer.list(meta, 'user-1')).toEqual({ attachments: [] });
    meta.attachments = [];
    expect(await importer.list(meta, 'user-1')).toEqual({ attachments: [candidate] });
  });

  it('keeps candidates for drafts without stored attachments and preserves discovery failures', async () => {
    delete meta.attachments;
    const candidate = { id: 'asset-1', filename: 'design.pdf' };
    invokeTracker.mockResolvedValueOnce({ attachments: [candidate] });
    expect(await importer.list(meta, 'user-1')).toEqual({ attachments: [candidate] });
    invokeTracker.mockResolvedValueOnce({ reason: 'Tracker disconnected' });
    expect(await importer.list(meta, 'user-1')).toEqual({ reason: 'Tracker disconnected' });
  });

  it('uses a new object key when a previously removed file is imported again', async () => {
    const first = await importer.importOne(meta, 'user-1', 'asset-1');
    meta.pendingAttachmentDeletions = [first.attachment];
    meta.attachments = [];
    const second = await importer.importOne(meta, 'user-1', 'asset-1');
    expect(second.attachment.s3Key).not.toBe(first.attachment.s3Key);
  });

  it('applies the total limit including pending browser uploads', async () => {
    meta.pendingAttachmentUploads = [
      {
        attachmentId: 'pending',
        size: 25 * 1024 * 1024,
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      },
    ];
    expect(await importer.importOne(meta, 'user-1', 'asset-1')).toMatchObject({
      status: 'skipped',
      reason: 'Attachments cannot exceed 25 MB in total',
    });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('rejects unsupported files and cleans the temporary version', async () => {
    invokeTracker.mockResolvedValueOnce({
      ...(await invokeTracker()),
      filename: 'design.doc',
      mimeType: 'application/msword',
    });
    const result = await importer.importOne(meta, 'user-1', 'asset-1');
    expect(result).toMatchObject({
      status: 'skipped',
      reason: expect.stringContaining('Unsupported'),
    });
    expect(store.updateExecution).not.toHaveBeenCalled();
    expect(s3.send.mock.calls.at(-1)[0].input.VersionId).toBe('download-v1');
  });

  it('rechecks draft state after downloading', async () => {
    store.getExecution.mockResolvedValue({ ...meta, status: 'RUNNING' });
    expect(await importer.importOne(meta, 'user-1', 'asset-1')).toMatchObject({ status: 'failed' });
    expect(ingest).not.toHaveBeenCalled();
  });

  it('retries reservation conflicts against fresh quotas', async () => {
    store.updateExecution.mockRejectedValueOnce(
      Object.assign(new Error('conflict'), { name: 'ConditionalCheckFailedException' }),
    );
    expect((await importer.importOne(meta, 'user-1', 'asset-1')).status).toBe('imported');
    expect(store.updateExecution).toHaveBeenCalledTimes(2);
  });

  it('releases the pending reservation after a promotion failure', async () => {
    ingest.mockRejectedValueOnce(new Error('copy failed'));
    expect((await importer.importOne(meta, 'user-1', 'asset-1')).status).toBe('failed');
    expect(meta.pendingAttachmentUploads).toEqual([]);
    expect(meta.attachmentRevision).toBe(2);
  });

  it('keeps provider failures isolated from existing attachments', async () => {
    invokeTracker.mockResolvedValueOnce({ status: 'failed', reason: 'Missing access' });
    expect(await importer.importOne(meta, 'user-1', 'asset-1')).toEqual({
      status: 'failed',
      reason: 'Missing access',
    });
    expect(store.updateExecution).not.toHaveBeenCalled();
  });
});

describe('provider file descriptors', () => {
  it('presigns uploads without an empty-body checksum', async () => {
    const sign = createTrackerUploadSigner({
      region: 'eu-central-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    });
    const url = new URL(await sign('artifacts', 'intent-attachments/staging/i/imports/1'));
    expect(
      [...url.searchParams.keys()].filter((name) => name.toLowerCase().includes('checksum')),
    ).toEqual([]);
    expect(url.searchParams.get('X-Amz-Content-Sha256')).toBe('UNSIGNED-PAYLOAD');
  });
  it('infers an extension for extensionless GitHub images', () => {
    expect(
      normalizeImportedAttachment({ filename: 'asset-id', mimeType: 'image/png', size: 12 }).value
        .filename,
    ).toBe('asset-id.png');
  });
  it('accepts generic download MIME types for known document extensions', () => {
    expect(
      normalizeImportedAttachment({
        filename: 'spec.docx',
        mimeType: 'application/octet-stream',
        size: 12,
      }).value.mimeType,
    ).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
  });
  it('does not import a login page returned for an image', () => {
    expect(
      normalizeImportedAttachment({ filename: 'asset-id', mimeType: 'text/html', size: 12 }).error,
    ).toBeTruthy();
  });
});
