import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { expect } from 'vitest';

export async function localSpaceTables({ managed = false } = {}) {
  const endpoint = new URL(process.env.DYNAMODB_LOCAL_ENDPOINT);
  expect(endpoint.protocol).toBe('http:');
  expect(['localhost', '127.0.0.1', '[::1]']).toContain(endpoint.hostname);
  expect(endpoint.username + endpoint.password + endpoint.search + endpoint.hash).toBe('');
  const raw = new DynamoDBClient({
    endpoint: endpoint.href,
    region: 'us-east-1',
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
  });
  const ddb = DynamoDBDocumentClient.from(raw, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const tables = [];
  async function create(prefix, names, index = []) {
    const tableName = `${prefix}-${randomUUID()}`;
    const keys = (fields) =>
      fields.map((AttributeName, i) => ({
        AttributeName,
        KeyType: i ? 'RANGE' : 'HASH',
      }));
    await raw.send(
      new CreateTableCommand({
        TableName: tableName,
        BillingMode: 'PAY_PER_REQUEST',
        KeySchema: keys(names),
        AttributeDefinitions: [...names, ...index].map((AttributeName) => ({
          AttributeName,
          AttributeType: 'S',
        })),
        ...(index.length && {
          GlobalSecondaryIndexes: [
            { IndexName: 'GSI1', KeySchema: keys(index), Projection: { ProjectionType: 'ALL' } },
          ],
        }),
      }),
    );
    tables.push(tableName);
    return tableName;
  }
  const close = async () => {
    try {
      for (const TableName of tables) await raw.send(new DeleteTableCommand({ TableName }));
    } finally {
      raw.destroy();
    }
  };
  try {
    return {
      ddb,
      tableName: await create('native-bindings', ['pk', 'sk']),
      yjsTable: await create('project-documents', ['documentId']),
      processTable: managed
        ? await create('managed-executions', ['pk', 'sk'], ['GSI1PK', 'GSI1SK'])
        : undefined,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
