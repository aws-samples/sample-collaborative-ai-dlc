// A review decision against the REAL store on DynamoDB Local: it lands only
// while the version still holds the image and scan the administrator saw.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createToolStore } from '../tool-store.js';

const TABLE = `env-registry-tool-review-${process.pid}-${Date.now()}`;
const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const ddb = DynamoDBDocumentClient.from(client);
const store = createToolStore({ ddb, tableName: TABLE });

const imageDigest = `sha256:${'b'.repeat(64)}`;
const shownAt = '2026-11-27T10:00:00.000Z';
const decision = { status: 'READY', securityFindingsAcceptedBy: 'admin@example.com' };

const putVersion = (scanFindings) =>
  ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        pk: 'TOOL#rust',
        sk: 'VERSION#tv-rust-1',
        toolId: 'rust',
        versionId: 'tv-rust-1',
        status: 'SECURITY_REVIEW',
        imageDigest,
        scanFindings,
      },
    }),
  );
const unavailableScan = {
  status: 'UNSUPPORTED',
  severityCounts: {},
  findings: [],
  evaluatedAt: shownAt,
  imageDigest,
};

describe('tool review decision on DynamoDB Local', () => {
  beforeAll(async () => {
    await client.send(
      new CreateTableCommand({
        TableName: TABLE,
        BillingMode: 'PAY_PER_REQUEST',
        AttributeDefinitions: [
          { AttributeName: 'pk', AttributeType: 'S' },
          { AttributeName: 'sk', AttributeType: 'S' },
          { AttributeName: 'GSI1PK', AttributeType: 'S' },
          { AttributeName: 'GSI1SK', AttributeType: 'S' },
        ],
        KeySchema: [
          { AttributeName: 'pk', KeyType: 'HASH' },
          { AttributeName: 'sk', KeyType: 'RANGE' },
        ],
        GlobalSecondaryIndexes: [
          {
            IndexName: 'GSI1',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      }),
    );
    await waitUntilTableExists({ client, maxWaitTime: 30 }, { TableName: TABLE });
  });

  afterAll(async () => {
    await client.send(new DeleteTableCommand({ TableName: TABLE }));
  });

  beforeEach(() => putVersion(unavailableScan));

  const decide = (scanEvaluatedAt) =>
    store.updateVersion('rust', 'tv-rust-1', decision, {
      fromStatus: 'SECURITY_REVIEW',
      imageDigest,
      scanEvaluatedAt,
    });

  it('records a decision on the scan the administrator saw, after a recheck claim', async () => {
    await store.claimScanRecheck('rust', 'tv-rust-1', {
      previous: null,
      at: '2026-11-27T10:05:00.000Z',
    });

    await expect(decide(shownAt)).resolves.toMatchObject({ status: 'READY' });
  });

  it('refuses a decision on a scan a recheck replaced with findings', async () => {
    await store.updateVersion(
      'rust',
      'tv-rust-1',
      {
        status: 'SECURITY_REVIEW',
        scanFindings: {
          status: 'ACTIVE',
          severityCounts: { CRITICAL: 1 },
          findings: [{ id: 'CVE-2026-9', severity: 'CRITICAL' }],
          evaluatedAt: '2026-11-27T10:15:00.000Z',
          imageDigest,
        },
      },
      { fromStatus: 'SECURITY_REVIEW', imageDigest },
    );

    await expect(decide(shownAt)).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    await expect(store.getVersion('rust', 'tv-rust-1')).resolves.toMatchObject({
      status: 'SECURITY_REVIEW',
    });
  });

  it('holds a decision on a scan stored without a time only while none is recorded', async () => {
    await expect(decide(null)).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });

    const { evaluatedAt: _omitted, ...legacyScan } = unavailableScan;
    await putVersion(legacyScan);
    await expect(decide(null)).resolves.toMatchObject({ status: 'READY' });
  });
});
