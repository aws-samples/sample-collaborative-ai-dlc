import { PutCommand } from '@aws-sdk/lib-dynamodb';

// Retain a scope marker so an unexpired collaboration token cannot recreate
// state after its parent is deleted. This does not delete stored snapshots.
export const revokeYjsScope = async ({ ddb, table, type, id }) => {
  if (!table || !ddb) return;
  if (!['intent', 'project', 'sprint'].includes(type) || !/^[0-9a-f-]{36}$/i.test(id)) {
    throw new Error('Invalid Yjs scope');
  }
  await ddb.send(
    new PutCommand({
      TableName: table,
      Item: { documentId: `scope#${type}:${id.toLowerCase()}`, deletedAt: Date.now() },
    }),
  );
};
