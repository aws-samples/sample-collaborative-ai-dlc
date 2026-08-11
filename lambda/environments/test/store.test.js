import { afterEach, describe, expect, it, vi } from 'vitest';
import { createEnvironmentStore } from '../store.js';

const keyOf = (key) => `${key.pk}|${key.sk}`;

const createDdb = (items) => ({
  send: vi.fn().mockImplementation(async (command) => {
    if (command.constructor.name === 'GetCommand') {
      return { Item: items.get(keyOf(command.input.Key)) };
    }
    if (command.constructor.name === 'TransactWriteCommand') {
      for (const operation of command.input.TransactItems) {
        if (operation.Put) items.set(keyOf(operation.Put.Item), operation.Put.Item);
        if (operation.Update) {
          const current = items.get(keyOf(operation.Update.Key));
          const values = operation.Update.ExpressionAttributeValues;
          items.set(keyOf(operation.Update.Key), {
            ...current,
            currentRevisionId: values[':revision'],
            status: values[':status'],
            updateAvailable: values[':yes'],
            updatedAt: values[':updated'],
          });
        }
      }
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }),
});

describe('environment registry store', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('stages a core update without changing the published Standard revision', async () => {
    vi.stubEnv('RUNTIME_COMPATIBILITY_VERSION', '2');
    const oldDigest = `sha256:${'a'.repeat(64)}`;
    const newDigest = `sha256:${'b'.repeat(64)}`;
    const base = {
      environmentId: 'core',
      revisionId: 'core-1',
      imageUri: 'core-repository',
      imageDigest: oldDigest,
    };
    const recipe = {
      schemaVersion: 1,
      base,
      tools: { node: { version: '24.15.0', source: 'base' } },
      buildTools: {},
      aptPackages: [],
      environmentVariables: {},
      buildCommands: [],
    };
    const items = new Map([
      [
        'ENV#standard|META',
        {
          pk: 'ENV#standard',
          sk: 'META',
          environmentId: 'standard',
          currentRevisionId: 'core-1',
          publishedRevisionId: 'core-1',
          status: 'PUBLISHED',
        },
      ],
      [
        'ENV#standard|REV#core-1',
        {
          pk: 'ENV#standard',
          sk: 'REV#core-1',
          environmentId: 'standard',
          revisionId: 'core-1',
          status: 'PUBLISHED',
          recipe,
          imageDigest: oldDigest,
        },
      ],
    ]);
    const ddb = createDdb(items);
    const store = createEnvironmentStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-10T00:00:00.000Z',
    });

    const staged = await store.stageCoreRevision({
      coreImageUri: 'core-repository',
      coreImageDigest: newDigest,
      coreRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core',
      coreRuntimeVersion: '2',
    });

    expect(staged).toMatchObject({
      status: 'READY',
      imageDigest: newDigest,
      runtimeCompatibilityVersion: '2',
      verification: { status: 'PASSED', source: 'core-runtime' },
    });
    expect(items.get('ENV#standard|META')).toMatchObject({
      publishedRevisionId: 'core-1',
      currentRevisionId: `core-2-${'b'.repeat(12)}`,
      status: 'UPDATE_AVAILABLE',
      updateAvailable: true,
    });
  });

  it('only sends expression-name aliases that an environment update uses', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({
        Attributes: {
          environmentId: 'custom',
          status: 'BUILDING',
        },
      }),
    };
    const store = createEnvironmentStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-10T00:00:00.000Z',
    });

    await store.updateEnvironment(
      'custom',
      {
        status: 'BUILDING',
        currentRevisionId: 'r-2',
      },
      {
        ifCurrentRevisionId: 'r-2',
        unlessRetired: true,
      },
    );

    expect(ddb.send.mock.calls[0][0].input).toMatchObject({
      ConditionExpression: 'currentRevisionId = :expectedCurrentRevision AND #status <> :retired',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':status': 'BUILDING',
        ':currentRevisionId': 'r-2',
        ':expectedCurrentRevision': 'r-2',
        ':retired': 'RETIRED',
      },
    });
    expect(ddb.send.mock.calls[0][0].input.ExpressionAttributeNames).not.toHaveProperty('#name');
  });

  it('persists resolved recipe prerequisites when a build is queued', async () => {
    const recipe = {
      schemaVersion: 1,
      base: null,
      tools: {},
      buildTools: {},
      aptPackages: [{ name: 'build-essential', version: '12.9' }],
      environmentVariables: {},
      buildCommands: [],
    };
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({
          Item: {
            environmentId: 'rust',
            revisionId: 'r-2',
            status: 'DRAFT',
          },
        })
        .mockResolvedValueOnce({
          Attributes: {
            environmentId: 'rust',
            revisionId: 'r-2',
            status: 'QUEUED',
            recipe,
            flattenedRecipe: recipe,
          },
        }),
    };
    const store = createEnvironmentStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-10T00:00:00.000Z',
    });

    await store.updateRevision(
      'rust',
      'r-2',
      {
        status: 'QUEUED',
        recipe,
        flattenedRecipe: recipe,
      },
      { fromStatus: 'DRAFT' },
    );

    expect(ddb.send.mock.calls[1][0].input).toMatchObject({
      ConditionExpression: '#status = :fromStatus',
      ExpressionAttributeValues: {
        ':status': 'QUEUED',
        ':recipe': recipe,
        ':flattenedRecipe': recipe,
        ':fromStatus': 'DRAFT',
      },
    });
  });

  it('rejects recipe changes after a revision is queued', async () => {
    const ddb = {
      send: vi.fn().mockResolvedValue({
        Item: {
          environmentId: 'rust',
          revisionId: 'r-2',
          status: 'BUILDING',
        },
      }),
    };
    const store = createEnvironmentStore({ ddb, tableName: 'registry' });

    await expect(
      store.updateRevision('rust', 'r-2', {
        recipe: { aptPackages: [{ name: 'build-essential', version: '12.9' }] },
      }),
    ).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(ddb.send).toHaveBeenCalledTimes(1);
  });

  it('moves the published pointer and base dependency in one transaction', async () => {
    const environment = {
      environmentId: 'custom',
      status: 'DRAFT',
      baseEnvironmentId: 'standard',
      publishedRevisionId: null,
    };
    const revision = {
      environmentId: 'custom',
      revisionId: 'r-2',
      status: 'READY',
      recipe: {
        base: {
          environmentId: 'jvm',
        },
      },
    };
    const ddb = {
      send: vi
        .fn()
        .mockResolvedValueOnce({})
        .mockResolvedValueOnce({ Item: { ...environment, publishedRevisionId: 'r-2' } })
        .mockResolvedValueOnce({ Item: { ...revision, status: 'PUBLISHED' } }),
    };
    const store = createEnvironmentStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-08-10T00:00:00.000Z',
    });

    await store.publishRevision({ environment, revision, actor: 'admin@example.com' });

    const transaction = ddb.send.mock.calls[0][0].input.TransactItems;
    expect(transaction[1].Update).toMatchObject({
      ConditionExpression:
        '(attribute_not_exists(publishedRevisionId) OR attribute_type(publishedRevisionId, :nullType)) AND #status <> :retired',
      ExpressionAttributeValues: {
        ':revision': 'r-2',
        ':base': 'jvm',
        ':published': 'PUBLISHED',
        ':nullType': 'NULL',
        ':retired': 'RETIRED',
      },
    });
  });

  it('rejects publication when the published pointer changes concurrently', async () => {
    const environment = {
      environmentId: 'custom',
      status: 'PUBLISHED',
      baseEnvironmentId: 'standard',
      publishedRevisionId: 'r-1',
    };
    const revision = {
      environmentId: 'custom',
      revisionId: 'r-2',
      status: 'READY',
      recipe: { base: { environmentId: 'standard' } },
    };
    const error = Object.assign(new Error('transaction cancelled'), {
      name: 'TransactionCanceledException',
    });
    const ddb = { send: vi.fn().mockRejectedValue(error) };
    const store = createEnvironmentStore({ ddb, tableName: 'registry' });

    await expect(
      store.publishRevision({ environment, revision, actor: 'admin@example.com' }),
    ).rejects.toMatchObject({
      statusCode: 409,
      code: 'PUBLISH_CONFLICT',
    });

    expect(ddb.send.mock.calls[0][0].input.TransactItems[1].Update).toMatchObject({
      ConditionExpression: 'publishedRevisionId = :previousPublished AND #status <> :retired',
      ExpressionAttributeValues: {
        ':previousPublished': 'r-1',
        ':retired': 'RETIRED',
      },
    });
  });
});
