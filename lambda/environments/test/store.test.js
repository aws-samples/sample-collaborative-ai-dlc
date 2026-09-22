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
    if (command.constructor.name === 'UpdateCommand') {
      // Minimal SET applier: "name = :token" pairs, resolving expression
      // attribute names, enough for updateRevision.
      const current = items.get(keyOf(command.input.Key)) ?? {};
      const names = command.input.ExpressionAttributeNames ?? {};
      const values = command.input.ExpressionAttributeValues ?? {};
      const next = { ...current };
      const sets = command.input.UpdateExpression.replace(/^SET\s+/, '').split(', ');
      for (const assignment of sets) {
        const [rawName, token] = assignment.split(' = ');
        next[names[rawName] ?? rawName] = values[token];
      }
      items.set(keyOf(command.input.Key), next);
      return { Attributes: next };
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
      coreAmd64Image: {
        imageUri: 'core-repository-amd64',
        imageDigest: `sha256:${'d'.repeat(64)}`,
      },
    });

    expect(staged).toMatchObject({
      status: 'READY',
      imageDigest: newDigest,
      runtimeCompatibilityVersion: '2',
      verification: { status: 'PASSED', source: 'core-runtime' },
      // The amd64 variant travels with the revision it belongs to.
      amd64Image: { imageUri: 'core-repository-amd64', imageDigest: `sha256:${'d'.repeat(64)}` },
    });
    expect(items.get('ENV#standard|META')).toMatchObject({
      publishedRevisionId: 'core-1',
      currentRevisionId: `core-2-${'b'.repeat(12)}`,
      status: 'UPDATE_AVAILABLE',
      updateAvailable: true,
    });
    // The published revision keeps ITS digest and gains no foreign variant —
    // an x86 environment created in the upgrade window resolves nothing new.
    expect(items.get('ENV#standard|REV#core-1').amd64Image).toBeUndefined();

    // Re-staging the SAME digest as the published revision backfills the
    // variant that belongs to it (pre-existing deployments gain x86 support).
    items.get('ENV#standard|REV#core-1').imageDigest = newDigest;
    const backfilled = await store.stageCoreRevision({
      coreImageUri: 'core-repository',
      coreImageDigest: newDigest,
      coreRuntimeArn: 'arn:aws:bedrock-agentcore:eu-west-1:123:runtime/core',
      coreRuntimeVersion: '2',
      coreAmd64Image: {
        imageUri: 'core-repository-amd64',
        imageDigest: `sha256:${'d'.repeat(64)}`,
      },
    });
    expect(backfilled).toBeNull();
    expect(items.get('ENV#standard|REV#core-1').amd64Image).toEqual({
      imageUri: 'core-repository-amd64',
      imageDigest: `sha256:${'d'.repeat(64)}`,
    });
  });

  it('marks an unpublished dependent when its current revision uses an older base', async () => {
    const environment = {
      environmentId: 'go',
      status: 'FAILED',
      baseEnvironmentId: 'standard',
      currentRevisionId: 'seed-go-1',
      publishedRevisionId: null,
      updateAvailable: false,
    };
    const revision = {
      environmentId: 'go',
      revisionId: 'seed-go-1',
      recipe: { base: { environmentId: 'standard', revisionId: 'core-old' } },
    };
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'QueryCommand') return { Items: [environment] };
        if (command.constructor.name === 'GetCommand') return { Item: revision };
        if (command.constructor.name === 'UpdateCommand') {
          return { Attributes: { ...environment, updateAvailable: true } };
        }
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    const store = createEnvironmentStore({ ddb, tableName: 'registry' });

    const changed = await store.markDependentsUpdateAvailable('standard', 'core-new');

    expect(changed).toEqual([{ ...environment, updateAvailable: true }]);
    const updateCall = ddb.send.mock.calls.find(
      ([command]) => command.constructor.name === 'UpdateCommand',
    );
    expect(updateCall).toBeDefined();
    expect(updateCall[0].input.ExpressionAttributeValues).toMatchObject({
      ':updateAvailable': true,
    });
  });

  it('clears the base-update flag when a latest-base revision is created', async () => {
    const environment = {
      environmentId: 'go',
      status: 'FAILED',
      currentRevisionId: 'seed-go-1',
      updateAvailable: true,
    };
    const recipe = {
      schemaVersion: 1,
      base: {
        environmentId: 'standard',
        revisionId: 'core-new',
        imageUri: 'core-repository',
        imageDigest: `sha256:${'c'.repeat(64)}`,
      },
      tools: {},
      buildTools: {},
      aptPackages: [],
      environmentVariables: {},
      buildCommands: [],
    };
    const ddb = {
      send: vi.fn().mockResolvedValue({}),
    };
    const store = createEnvironmentStore({
      ddb,
      tableName: 'registry',
      ids: () => 'new',
      clock: () => '2026-08-12T12:00:00.000Z',
    });

    await store.createRevision({
      environment,
      recipe,
      createdBy: 'admin@example.com',
      reason: 'latest-base',
      clearUpdateAvailable: true,
    });

    const transaction = ddb.send.mock.calls[0][0].input.TransactItems;
    expect(transaction[1].Update).toMatchObject({
      UpdateExpression:
        'SET currentRevisionId = :revision, #status = :status, updatedAt = :updated, updateAvailable = :no',
      ExpressionAttributeValues: {
        ':revision': 'r-new',
        ':status': 'DRAFT',
        ':updated': '2026-08-12T12:00:00.000Z',
        ':no': false,
      },
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

describe('session cleanup records', () => {
  it('persists the provider/session identity into the shared GSI1 partition', async () => {
    const sends = [];
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        sends.push(command);
        if (command.constructor.name === 'QueryCommand') return { Items: [] };
        return {};
      }),
    };
    const store = createEnvironmentStore({
      ddb,
      tableName: 'registry',
      clock: () => '2026-01-01T00:00:00.000Z',
    });

    const item = await store.putSessionCleanup({
      sessionId: 'managed-environment-r-1-session',
      capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/cp-1',
      environmentId: 'x86-build',
      revisionId: 'r-1',
      reason: 'internal error',
    });
    expect(item).toMatchObject({
      pk: 'SESSION_CLEANUP#managed-environment-r-1-session',
      sk: 'LOOKUP',
      GSI1PK: 'SESSION_CLEANUP',
      sessionId: 'managed-environment-r-1-session',
      capacityProviderArn: 'arn:aws:bedrock-agentcore:us-east-1:1:capacity-provider/cp-1',
      attempts: 0,
    });

    await store.listSessionCleanups();
    const query = sends.find((command) => command.constructor.name === 'QueryCommand');
    expect(query.input.ExpressionAttributeValues[':pk']).toBe('SESSION_CLEANUP');

    await store.deleteSessionCleanup('managed-environment-r-1-session');
    const deletion = sends.find((command) => command.constructor.name === 'DeleteCommand');
    expect(deletion.input.Key).toEqual({
      pk: 'SESSION_CLEANUP#managed-environment-r-1-session',
      sk: 'LOOKUP',
    });
  });

  it('refuses to persist a record without the session or provider identity', async () => {
    const ddb = { send: vi.fn() };
    const store = createEnvironmentStore({ ddb, tableName: 'registry' });
    expect(await store.putSessionCleanup({ sessionId: 's-1' })).toBeNull();
    expect(await store.putSessionCleanup({ capacityProviderArn: 'arn:cp' })).toBeNull();
    expect(ddb.send).not.toHaveBeenCalled();
  });
});
