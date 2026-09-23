import { describe, expect, it, vi } from 'vitest';
import { revokeYjsScope, reconcileYjsDeletion } from '../yjs-revocation.js';
const id = 'b6326738-6b97-4819-829a-565ee8903e38';

describe('Yjs deletion fencing and retention', () => {
  it('fences every page, including legacy ids and epochs, and purges exact S3 versions', async () => {
    const first = `intent-artifact-${id}-arbitrary-epoch-v2`;
    const second = `intent-draft-${id.toUpperCase()}`;
    const operations = [];
    const ddb = {
      send: vi.fn(async (command) => {
        operations.push(command);
        if (command.constructor.name === 'ScanCommand')
          return command.input.ExclusiveStartKey
            ? { Items: [{ documentId: second }] }
            : {
                Items: [{ documentId: first }, { documentId: 'unrelated' }],
                LastEvaluatedKey: { documentId: first },
              };
        return {};
      }),
    };
    const s3 = {
      send: vi.fn(async (command) => {
        operations.push(command);
        if (command.constructor.name === 'ListObjectVersionsCommand')
          return command.input.KeyMarker
            ? {}
            : {
                Versions: [
                  { Key: 'key', VersionId: 'committed' },
                  { Key: 'key', VersionId: 'old' },
                ],
                DeleteMarkers: [{ Key: 'key', VersionId: 'marker' }],
                IsTruncated: true,
                NextKeyMarker: 'key',
                NextVersionIdMarker: 'marker',
              };
        return {};
      }),
    };
    await revokeYjsScope({ ddb, table: 'docs', bucket: 'snapshots', type: 'intent', id, s3 });
    expect(operations.find((c) => c.constructor.name === 'PutCommand').input.Item.documentId).toBe(
      `scope#intent:${id}`,
    );
    const fenced = operations.filter(
      (c) =>
        c.constructor.name === 'UpdateCommand' && c.input.ExpressionAttributeValues[':deleted'],
    );
    expect(fenced.map((c) => c.input.Key.documentId)).toEqual([first, second]);
    expect(
      operations
        .filter((c) => c.constructor.name === 'ScanCommand')
        .every((c) => c.input.ConsistentRead),
    ).toBe(true);
    const deleted = operations.find((c) => c.constructor.name === 'DeleteObjectsCommand');
    expect(deleted.input.Delete.Objects.map((v) => v.VersionId)).toEqual([
      'committed',
      'old',
      'marker',
    ]);
    expect(operations.indexOf(deleted)).toBeGreaterThan(operations.indexOf(fenced.at(-1)));
  });

  it('revisits a fenced scope for late uploads and leaves a failed purge due for retry', async () => {
    const marker = { documentId: `scope#intent:${id}`, cleanupState: 'fenced' };
    const ddb = {
      send: vi.fn(async (command) =>
        command.constructor.name === 'QueryCommand' ? { Items: [marker] } : {},
      ),
    };
    let reject = true;
    const s3 = {
      send: vi.fn(async (command) =>
        command.constructor.name === 'ListObjectVersionsCommand'
          ? { Versions: [{ Key: `yjs-documents/intent/${id}/late.bin`, VersionId: 'late' }] }
          : reject
            ? { Errors: [{ Code: 'AccessDenied' }] }
            : {},
      ),
    };
    await expect(
      reconcileYjsDeletion({ ddb, table: 'docs', bucket: 'snapshots', s3 }),
    ).rejects.toThrow('1 failed');
    expect(ddb.send.mock.calls.some(([c]) => c.constructor.name === 'UpdateCommand')).toBe(false);
    reject = false;
    await expect(
      reconcileYjsDeletion({ ddb, table: 'docs', bucket: 'snapshots', s3 }),
    ).resolves.toEqual({ cleaned: 1, failed: 0 });
    const next = ddb.send.mock.calls.find(([c]) => c.constructor.name === 'UpdateCommand')[0];
    expect(next.input.ExpressionAttributeValues[':next']).toBeGreaterThan(
      next.input.ExpressionAttributeValues[':now'],
    );
  });
});
