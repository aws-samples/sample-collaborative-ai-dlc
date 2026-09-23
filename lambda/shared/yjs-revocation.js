import {
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, ListObjectVersionsCommand, DeleteObjectsCommand } from '@aws-sdk/client-s3';
import { requiredScopeForYjsDoc } from './realtime-token.js';

const s3Client = new S3Client({
  maxAttempts: 3,
  requestHandler: { connectionTimeout: 2000, requestTimeout: 5000 },
});
const validateScope = (type, id) => {
  if (
    !['intent', 'project', 'sprint'].includes(type) ||
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(id)
  )
    throw new Error('Invalid Yjs scope');
  return `${type}:${id.toLowerCase()}`;
};

export const purgeYjsSnapshots = async ({ bucket, type, id, s3 = s3Client }) => {
  validateScope(type, id);
  if (!bucket) return;
  const Prefix = `yjs-documents/${type}/${id.toLowerCase()}/`;
  let KeyMarker, VersionIdMarker;
  do {
    const page = await s3.send(
      new ListObjectVersionsCommand({ Bucket: bucket, Prefix, KeyMarker, VersionIdMarker }),
    );
    const versions = [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])].map((v) => ({
      Key: v.Key,
      VersionId: v.VersionId,
    }));
    if (versions.length) {
      const result = await s3.send(
        new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: versions } }),
      );
      if (result.Errors?.length)
        throw new Error(`Yjs snapshot purge failed for ${result.Errors.length} versions`);
    }
    KeyMarker = page.NextKeyMarker;
    VersionIdMarker = page.NextVersionIdMarker;
    if (!page.IsTruncated) break;
    if (!KeyMarker) throw new Error('Truncated Yjs snapshot listing has no cursor');
  } while (KeyMarker);
};

// Parent tombstones are permanent. Claims atomically check the parent, so once
// this put completes no new document can enter the scope. A strongly consistent
// scan then enumerates ALL previously claimed documents (including old schemas,
// arbitrary artifact ids, and collaboration epochs). Deletion is infrequent;
// the hot checkpoint/renewal path never touches a shared parent item.
export const revokeYjsScope = async ({
  ddb,
  table,
  type,
  id,
  bucket,
  s3 = s3Client,
  clock = Date.now,
  scanBudgetMs = 20_000,
}) => {
  if (!table || !ddb) return;
  const scope = validateScope(type, id);
  const startedAt = clock();
  const markerKey = { documentId: `scope#${scope}` };
  let marker = (
    await ddb.send(new GetCommand({ TableName: table, Key: markerKey, ConsistentRead: true }))
  ).Item;
  if (!marker?.deletedAt) {
    marker = {
      ...markerKey,
      deletedAt: startedAt,
      cleanupPartition: 'DELETED',
      cleanupAfter: startedAt + 60_000,
      cleanupState: 'pending',
    };
    try {
      await ddb.send(
        new PutCommand({
          TableName: table,
          Item: marker,
          ConditionExpression: 'attribute_not_exists(deletedAt)',
        }),
      );
    } catch (error) {
      if (error.name !== 'ConditionalCheckFailedException') throw error;
      marker = (
        await ddb.send(new GetCommand({ TableName: table, Key: markerKey, ConsistentRead: true }))
      ).Item;
      if (!marker?.deletedAt) throw error;
    }
  }
  const deletedAt = marker.deletedAt;
  if (!marker.cleanupPartition) {
    await ddb.send(
      new UpdateCommand({
        TableName: table,
        Key: markerKey,
        UpdateExpression:
          'SET cleanupPartition = :partition, cleanupAfter = :after, cleanupState = if_not_exists(cleanupState, :pending)',
        ExpressionAttributeValues: {
          ':partition': 'DELETED',
          ':after': startedAt + 60_000,
          ':pending': 'pending',
        },
      }),
    );
  }
  let ExclusiveStartKey = marker.cleanupCursor ?? undefined;
  if (marker.cleanupState !== 'fenced')
    do {
      const previousCursor = ExclusiveStartKey ?? null;
      const page = await ddb.send(
        new ScanCommand({
          TableName: table,
          ConsistentRead: true,
          ExclusiveStartKey,
          FilterExpression: 'attribute_not_exists(cleanupPartition)',
          ProjectionExpression: 'documentId',
        }),
      );
      const documents = (page.Items ?? []).filter(
        (row) => requiredScopeForYjsDoc(row.documentId) === scope,
      );
      for (let offset = 0; offset < documents.length; offset += 16) {
        await Promise.all(
          documents.slice(offset, offset + 16).map((row) =>
            ddb.send(
              new UpdateCommand({
                TableName: table,
                Key: { documentId: row.documentId },
                UpdateExpression:
                  'SET deletedAt = :deleted REMOVE ownerId, ownerAddress, leaseToken, leaseUntil',
                ExpressionAttributeValues: { ':deleted': deletedAt },
              }),
            ),
          ),
        );
        // No claimant can recreate these rows, and old renewals/checkpoints
        // require the removed ownership token. This also removes legacy CRDT blobs.
        await Promise.all(
          documents.slice(offset, offset + 16).map((row) =>
            ddb
              .send(
                new DeleteCommand({
                  TableName: table,
                  Key: { documentId: row.documentId },
                  ConditionExpression: 'deletedAt = :deleted',
                  ExpressionAttributeValues: { ':deleted': deletedAt },
                }),
              )
              .catch((error) => {
                if (error.name !== 'ConditionalCheckFailedException') throw error;
              }),
          ),
        );
      }
      ExclusiveStartKey = page.LastEvaluatedKey;
      // Persist progress after every page. A concurrent retry cannot move this
      // cursor backwards or reopen a completed fence; incomplete scans stay due.
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: markerKey,
          UpdateExpression: ExclusiveStartKey
            ? 'SET cleanupCursor = :cursor'
            : 'SET cleanupState = :fenced REMOVE cleanupCursor',
          ConditionExpression:
            'cleanupState = :pending AND ' +
            (previousCursor === null
              ? 'attribute_not_exists(cleanupCursor)'
              : 'cleanupCursor = :previous'),
          ExpressionAttributeValues: {
            ':pending': 'pending',
            ...(previousCursor === null ? {} : { ':previous': previousCursor }),
            ...(ExclusiveStartKey ? { ':cursor': ExclusiveStartKey } : { ':fenced': 'fenced' }),
          },
        }),
      );
      if (ExclusiveStartKey && clock() - startedAt >= scanBudgetMs) {
        const error = new Error('Yjs deletion is in progress; retry the delete');
        error.code = 'YJS_CLEANUP_PENDING';
        throw error;
      }
    } while (ExclusiveStartKey);
  await purgeYjsSnapshots({ bucket, type, id, s3 });
};

// Revisit permanent tombstones to clean uploads whose S3 response was lost or
// which finished after the synchronous purge. The sparse due-time index bounds
// work per invocation and prioritizes the oldest cleanup; errors remain due.
export const reconcileYjsDeletion = async ({
  ddb,
  table,
  bucket,
  s3 = s3Client,
  now = Date.now(),
  limit = 20,
}) => {
  if (!table || !bucket) return { cleaned: 0, failed: 0 };
  const due = await ddb.send(
    new QueryCommand({
      TableName: table,
      IndexName: 'cleanup',
      KeyConditionExpression: 'cleanupPartition = :partition AND cleanupAfter <= :now',
      ExpressionAttributeValues: { ':partition': 'DELETED', ':now': now },
      Limit: limit,
    }),
  );
  let cleaned = 0,
    failed = 0,
    pending = 0;
  for (const marker of due.Items ?? []) {
    const [type, id] = marker.documentId.slice('scope#'.length).split(':');
    try {
      if (marker.cleanupState !== 'fenced')
        await revokeYjsScope({ ddb, table, bucket, type, id, s3 });
      else await purgeYjsSnapshots({ bucket, type, id, s3 });
      await ddb.send(
        new UpdateCommand({
          TableName: table,
          Key: { documentId: marker.documentId },
          UpdateExpression: 'SET cleanupAfter = :next, lastCleanupAt = :now',
          ExpressionAttributeValues: { ':next': now + 3600_000, ':now': now },
        }),
      );
      cleaned++;
    } catch (error) {
      if (
        error.code === 'YJS_CLEANUP_PENDING' ||
        error.name === 'ConditionalCheckFailedException'
      ) {
        pending++;
        continue;
      }
      failed++;
      console.error('Yjs deletion reconciliation failed:', marker.documentId, error.name);
    }
  }
  if (failed) throw new Error(`Yjs deletion reconciliation: ${failed} failed, ${cleaned} cleaned`);
  return { cleaned, failed, ...(pending ? { pending } : {}) };
};
