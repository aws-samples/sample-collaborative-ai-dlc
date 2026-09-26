// Register pre-upgrade tombstones with the sparse cleanup index. Dry-run by
// default; use YJS_DOCUMENTS_TABLE=... AWS_PROFILE=... node ... --apply.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
const TableName = process.env.YJS_DOCUMENTS_TABLE;
if (!TableName) throw new Error('YJS_DOCUMENTS_TABLE is required');
const apply = process.argv.includes('--apply');
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
let ExclusiveStartKey,
  found = 0,
  updated = 0;
do {
  const page = await ddb.send(
    new ScanCommand({
      TableName,
      ConsistentRead: true,
      ExclusiveStartKey,
      FilterExpression:
        'begins_with(documentId, :scope) AND attribute_exists(deletedAt) AND attribute_not_exists(cleanupPartition)',
      ExpressionAttributeValues: { ':scope': 'scope#' },
      ProjectionExpression: 'documentId, deletedAt',
    }),
  );
  for (const row of page.Items ?? []) {
    if (
      !/^scope#(intent|project|sprint):[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(
        row.documentId,
      )
    )
      throw new Error('Invalid stored Yjs scope tombstone');
    found++;
    if (apply) {
      try {
        await ddb.send(
          new UpdateCommand({
            TableName,
            Key: { documentId: row.documentId },
            UpdateExpression:
              'SET cleanupPartition = :partition, cleanupAfter = :after, cleanupState = :pending',
            ConditionExpression: 'deletedAt = :deleted AND attribute_not_exists(cleanupPartition)',
            ExpressionAttributeValues: {
              ':partition': 'DELETED',
              ':after': Date.now(),
              ':pending': 'pending',
              ':deleted': row.deletedAt,
            },
          }),
        );
        updated++;
      } catch (error) {
        if (error.name !== 'ConditionalCheckFailedException') throw error;
      }
    }
  }
  ExclusiveStartKey = page.LastEvaluatedKey;
} while (ExclusiveStartKey);
console.log(JSON.stringify({ table: TableName, apply, found, updated }));
