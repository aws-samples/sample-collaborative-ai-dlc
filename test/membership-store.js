import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

// Capture the real transport before individual suites mock DocumentClient for
// unrelated process/integration tables. Membership tests still use DynamoDB Local.
const send = DynamoDBDocumentClient.prototype.send;
export const createTestMembershipStore = async (createMembershipStore) => {
  const client = new DynamoDBClient({
    endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
    region: 'us-east-1',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const ddb = DynamoDBDocumentClient.from(client);
  ddb.send = send.bind(ddb);
  const accessTable = `access-${randomUUID()}`;
  const auditTable = `audit-${randomUUID()}`;
  for (const TableName of [accessTable, auditTable]) {
    await client.send(
      new CreateTableCommand({
        TableName,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          ...(TableName === accessTable ? [{ AttributeName: 'userId', AttributeType: 'S' }] : []),
        ],
        ...(TableName === accessTable
          ? {
              GlobalSecondaryIndexes: [
                {
                  IndexName: 'by-user',
                  KeySchema: [
                    { AttributeName: 'userId', KeyType: 'HASH' },
                    { AttributeName: 'pk', KeyType: 'RANGE' },
                  ],
                  Projection: { ProjectionType: 'ALL' },
                },
              ],
            }
          : {}),
      }),
    );
  }
  return {
    store: createMembershipStore({ ddb, accessTable, auditTable }),
    ddb,
    accessTable,
    auditTable,
    cleanup: async () => {
      await Promise.all(
        [accessTable, auditTable].map((TableName) =>
          client.send(new DeleteTableCommand({ TableName })),
        ),
      );
      client.destroy();
    },
  };
};
