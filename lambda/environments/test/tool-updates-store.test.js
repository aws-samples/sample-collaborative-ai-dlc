// markToolUpdatesAvailable against the REAL store on DynamoDB Local. A tool
// recommendation is per architecture: an arm64 recommendation must flag only
// arm64 environments and an x86_64 recommendation only x86_64 environments,
// even when both resolve the same tool family.
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, ScanCommand, DeleteCommand } from '@aws-sdk/lib-dynamodb';
import { createEnvironmentStore } from '../store.js';
import { CATALOG_RECIPE_SCHEMA_VERSION } from '../catalog-recipe.js';
import { toolVersionSnapshot } from '../tool-catalog.js';

const TABLE = `env-registry-tool-updates-${process.pid}-${Date.now()}`;
const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const ddb = DynamoDBDocumentClient.from(client);
const store = createEnvironmentStore({ ddb, tableName: TABLE });

// A published Java tool version, snapshotted the way catalog resolution does
// it: arm64 snapshots carry no architecture field, x86_64 snapshots do.
const javaSnapshot = (versionId, architecture) =>
  toolVersionSnapshot(
    {
      toolId: 'java',
      versionId,
      status: 'PUBLISHED',
      imageUri: 'registry/tools',
      imageDigest: `sha256:${'c'.repeat(64)}`,
      imageSizeBytes: 100,
      source: { sha256: 'd'.repeat(64), sizeBytes: 100, trustLevel: 'PUBLISHER_VERIFIED' },
      definition: {
        version: '21.0.7',
        distribution: 'Eclipse Temurin',
        publisher: 'Eclipse Adoptium',
        ...(architecture === 'x86_64' ? { architecture: 'x86_64' } : {}),
        executables: [{ name: 'java', path: 'bin/java' }],
        dependencies: [],
        aptPackages: [],
        environmentVariables: {},
        verification: {
          preset: 'java',
          versionCommand: { argv: ['java', '-version'], expected: '21.0.7' },
          script: '',
          files: [],
        },
      },
    },
    { name: 'Java JDK', category: 'language-sdk', publisher: 'Eclipse Temurin' },
  );

// Creates an environment and publishes its first revision, so the published
// revision resolves the given Java version.
const publishedEnvironment = async ({ environmentId, architecture, versionId }) => {
  const tool = javaSnapshot(versionId, architecture);
  const recipe = {
    schemaVersion: CATALOG_RECIPE_SCHEMA_VERSION,
    base: {
      environmentId: 'standard',
      revisionId: 'core-1',
      imageUri: 'core-repository',
      imageDigest: `sha256:${'a'.repeat(64)}`,
      imageSizeBytes: null,
    },
    ...(architecture === 'x86_64' ? { architecture: 'x86_64' } : {}),
    toolVersionIds: [versionId],
    tools: [tool],
    aptPackages: [],
    environmentVariables: {},
    buildCommands: [],
  };
  const { revision } = await store.createEnvironment({
    environmentId,
    name: environmentId,
    recipe,
    flattenedRecipe: { ...recipe, resolvedTools: [tool] },
    createdBy: 'test',
    compute: architecture === 'x86_64' ? { type: 'instances', architecture: 'x86_64' } : null,
  });
  await store.updateEnvironment(environmentId, {
    status: 'PUBLISHED',
    publishedRevisionId: revision.revisionId,
  });
};

const flags = async () =>
  Object.fromEntries(
    await Promise.all(
      ['arm-java', 'x86-java'].map(async (id) => {
        const environment = await store.getEnvironment(id);
        return [
          id,
          {
            status: environment.status,
            updateAvailable: environment.updateAvailable,
            toolUpdates: environment.toolUpdates,
          },
        ];
      }),
    ),
  );

const UNCHANGED = { status: 'PUBLISHED', updateAvailable: false, toolUpdates: [] };

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
  await client.send(new DeleteTableCommand({ TableName: TABLE })).catch(() => {});
});

beforeEach(async () => {
  const { Items = [] } = await ddb.send(new ScanCommand({ TableName: TABLE }));
  for (const item of Items) {
    await ddb.send(new DeleteCommand({ TableName: TABLE, Key: { pk: item.pk, sk: item.sk } }));
  }
  await publishedEnvironment({
    environmentId: 'arm-java',
    architecture: 'arm64',
    versionId: 'tv-java-arm-old',
  });
  await publishedEnvironment({
    environmentId: 'x86-java',
    architecture: 'x86_64',
    versionId: 'tv-java-x86-old',
  });
});

describe('markToolUpdatesAvailable per architecture (real store)', () => {
  it('an x86_64 recommendation flags only the x86_64 environment', async () => {
    const changed = await store.markToolUpdatesAvailable('java', 'tv-java-x86-new', 'x86_64');

    expect(changed.map((environment) => environment.environmentId)).toEqual(['x86-java']);
    expect(await flags()).toEqual({
      'arm-java': UNCHANGED,
      'x86-java': {
        status: 'UPDATE_AVAILABLE',
        updateAvailable: true,
        toolUpdates: [
          {
            toolId: 'java',
            currentVersionId: 'tv-java-x86-old',
            recommendedVersionId: 'tv-java-x86-new',
          },
        ],
      },
    });
  });

  it('an arm64 recommendation flags only the arm64 environment', async () => {
    const changed = await store.markToolUpdatesAvailable('java', 'tv-java-arm-new', 'arm64');

    expect(changed.map((environment) => environment.environmentId)).toEqual(['arm-java']);
    expect(await flags()).toEqual({
      'arm-java': {
        status: 'UPDATE_AVAILABLE',
        updateAvailable: true,
        toolUpdates: [
          {
            toolId: 'java',
            currentVersionId: 'tv-java-arm-old',
            recommendedVersionId: 'tv-java-arm-new',
          },
        ],
      },
      'x86-java': UNCHANGED,
    });
  });

  it('the two-argument call behaves as arm64', async () => {
    const changed = await store.markToolUpdatesAvailable('java', 'tv-java-arm-new');

    expect(changed.map((environment) => environment.environmentId)).toEqual(['arm-java']);
    expect((await flags())['x86-java']).toEqual(UNCHANGED);
    expect((await flags())['arm-java'].updateAvailable).toBe(true);
  });
});
