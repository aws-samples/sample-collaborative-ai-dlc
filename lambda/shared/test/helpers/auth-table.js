// Test helper: per-suite authentication control tables in the shared DynamoDB Local
// container (pk/sk only, like the process table the repository writes to). Each test
// file gets its own client through module isolation; register the hooks per file:
//   beforeAll(requireDynamoDbLocal);
//   afterAll(cleanup);
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

export const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
export const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const tables = [];

export const requireDynamoDbLocal = () => {
  if (!process.env.DYNAMODB_LOCAL_ENDPOINT) throw new Error('DynamoDB Local is required');
};

export const createAuthTable = async (prefix = 'agent-auth') => {
  const TableName = `${prefix}-${randomUUID()}`;
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
      ],
    }),
  );
  tables.push(TableName);
  return TableName;
};

export const cleanup = async () => {
  await Promise.all(
    tables.splice(0).map((TableName) => client.send(new DeleteTableCommand({ TableName }))),
  );
  client.destroy();
};
