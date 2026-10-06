import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  PutCommand,
  QueryCommand,
  ScanCommand,
  GetCommand,
  BatchWriteCommand,
  TransactWriteCommand,
  UpdateCommand,
  DeleteCommand,
} from '@aws-sdk/lib-dynamodb';
import { createAgentConnectionRepository } from '../agent-connection-repository.js';
import { createAgentAuthChangeService, credentialUpdateCandidate } from '../agent-auth-changes.js';
import { resolveSelectedAgentCredential } from '../agent-credential-service.js';
import { resolvePolicyBindings } from '../agent-binding-selection.js';
import { inspectAgentCredentialMetadata } from '../../credential-metadata/index.js';
import { createProcessStore } from '../v2-process-store.js';
import { cleanup, createAuthTable, ddb, requireDynamoDbLocal } from './helpers/auth-table.js';
import { inventoryReferenceWrites } from '../agent-auth-inventory.js';

beforeAll(requireDynamoDbLocal);
afterAll(cleanup);
const setup = async () => {
  const tableName = await createAuthTable('auth-review');
  const calls = [];
  const recordingDdb = {
    send: (command) => {
      calls.push(command);
      return ddb.send(command);
    },
  };
  const repository = createAgentConnectionRepository({
    ddb: recordingDdb,
    tableName,
    base: '/review/test',
  });
  await repository.initializeInventory();
  const service = createAgentAuthChangeService({ repository });
  return { tableName, repository, service, calls, recordingDdb };
};

describe('provider and scope isolation', () => {
  it('can rotate a space key with more than 5,000 finished invocations and stale references', async () => {
    const { tableName, repository, service, calls } = await setup();
    const records = Array.from({ length: 5001 }, (_, index) => ({
      pk: `AGENTAUTH#INVOCATION#finished-${index}`,
      sk: 'META',
      type: 'AgentInvocation',
      id: `finished-${index}`,
      projectId: 'busy-space',
      state: 'FINISHED',
      credentialBinding: { provider: 'bedrock', source: 'space' },
      // Historical references had no TTL, and TTL deletion is asynchronous.
    })).flatMap((row) => [
      row,
      ...inventoryReferenceWrites(tableName, row).map(({ Put }) => Put.Item),
    ]);
    const missing = { pk: 'EXEC#deleted', sk: 'META', projectId: 'busy-space' };
    records.push(...inventoryReferenceWrites(tableName, missing).map(({ Put }) => Put.Item));
    for (let offset = 0; offset < records.length; offset += 25) {
      const result = await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: records
              .slice(offset, offset + 25)
              .map((Item) => ({ PutRequest: { Item } })),
          },
        }),
      );
      expect(result.UnprocessedItems ?? {}).toEqual({});
    }
    const candidate = credentialUpdateCandidate({
      source: 'space',
      projectId: 'busy-space',
      update: { bedrockBearerToken: 'rotated' },
    });
    calls.length = 0;
    const review = await service.preview(candidate, 'admin');
    expect(review.items).toEqual([]);
    const writeCredentials = vi.fn(async () => {});
    await expect(
      service.apply(review.id, 'admin', { candidate, writeCredentials }),
    ).resolves.toMatchObject({ saved: true });
    expect(writeCredentials).toHaveBeenCalledOnce();
    expect(calls.some((command) => command instanceof ScanCommand)).toBe(false);
    expect(await repository.loadInventory(candidate)).toEqual([]);
  }, 60_000);

  it('still rejects a scoped review with more than 5,000 material records', async () => {
    const send = vi.fn(async (command) => {
      if (command instanceof QueryCommand) {
        const offset = command.input.ExclusiveStartKey?.offset ?? 0;
        return {
          Items: Array.from({ length: offset === 5000 ? 1 : 100 }, (_, index) => ({
            target: { pk: `AGENTAUTH#INVOCATION#${offset + index}`, sk: 'META' },
          })),
          ...(offset < 5000 ? { LastEvaluatedKey: { offset: offset + 100 } } : {}),
        };
      }
      if (command.input.Key.pk === 'AGENTAUTH#INVENTORY') return { Item: { version: 1 } };
      return {
        Item: {
          ...command.input.Key,
          type: 'AgentInvocation',
          state: 'ACTIVE',
          projectId: 'busy-space',
        },
      };
    });
    const repository = createAgentConnectionRepository({ ddb: { send }, tableName: 'inventory' });
    await expect(
      repository.loadInventory({ source: 'space', projectId: 'busy-space' }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_INVENTORY_TOO_LARGE' });
  });

  it('retains rewindable execution references and removes them atomically on deletion', async () => {
    const { tableName, repository } = await setup();
    const store = createProcessStore({ ddb, tableName });
    await store.createExecution({
      executionId: 'rewindable',
      projectId: 'p1',
      credentialBinding: { provider: 'bedrock', source: 'user', userId: 'u1' },
    });
    for (const status of ['SUCCEEDED', 'FAILED', 'CANCELLED']) {
      await store.updateExecution({ executionId: 'rewindable', status });
      expect(await repository.loadInventory({ source: 'user', userId: 'u1' })).toMatchObject([
        { executionId: 'rewindable', status },
      ]);
    }
    const execution = await store.getExecution('rewindable');
    await store.deleteExecution('rewindable');
    expect(await store.getExecution('rewindable')).toBeNull();
    for (const { Put } of inventoryReferenceWrites(tableName, execution)) {
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: Put.Item.pk, sk: Put.Item.sk },
          ConsistentRead: true,
        }),
      );
      expect(Item).toBeUndefined();
    }
    expect(await repository.loadInventory({ source: 'space', projectId: 'p1' })).toEqual([]);
    await expect(store.deleteExecution('rewindable')).resolves.toEqual({ deleted: 0 });
  });

  it('initializes an empty installation once and permits its first scoped review', async () => {
    const tableName = await createAuthTable('fresh-auth');
    const calls = [];
    const repository = createAgentConnectionRepository({
      ddb: {
        send: (command) => {
          calls.push(command);
          return ddb.send(command);
        },
      },
      tableName,
    });
    expect(await repository.initializeInventory()).toEqual({ initialized: true, records: 0 });
    calls.length = 0;
    expect(await repository.initializeInventory()).toEqual({ initialized: false, records: 0 });
    expect(calls.some((command) => command instanceof ScanCommand)).toBe(false);
    const service = createAgentAuthChangeService({ repository });
    const candidate = credentialUpdateCandidate({
      source: 'user',
      userId: 'first-user',
      update: { kiroApiKey: 'new-key' },
    });
    const review = await service.preview(candidate, 'first-user');
    await expect(
      service.apply(review.id, 'first-user', {
        candidate,
        writeCredentials: async () => {},
      }),
    ).resolves.toMatchObject({ saved: true });
  });

  it.each(['finish', 'delete'])(
    'backfill preserves a concurrent invocation %s',
    async (operation) => {
      const tableName = await createAuthTable('backfill-race');
      const row = {
        pk: 'AGENTAUTH#INVOCATION#racing',
        sk: 'META',
        type: 'AgentInvocation',
        state: 'ACTIVE',
        projectId: 'p1',
      };
      const Key = { pk: row.pk, sk: row.sk };
      await ddb.send(new PutCommand({ TableName: tableName, Item: row }));
      const ttl = Math.floor(Date.now() / 1000) + 86400;
      let raced = false;
      const repository = createAgentConnectionRepository({
        tableName,
        ddb: {
          async send(command) {
            if (!raced && command instanceof TransactWriteCommand) {
              raced = true;
              await ddb.send(
                operation === 'delete'
                  ? new DeleteCommand({ TableName: tableName, Key })
                  : new UpdateCommand({
                      TableName: tableName,
                      Key,
                      UpdateExpression: 'SET #state = :state, agentAuthTtl = :ttl',
                      ExpressionAttributeNames: { '#state': 'state' },
                      ExpressionAttributeValues: { ':state': 'FINISHED', ':ttl': ttl },
                    }),
              );
            }
            return ddb.send(command);
          },
        },
      });
      await repository.initializeInventory();
      expect(raced).toBe(true);
      const { Put } = inventoryReferenceWrites(tableName, row)[0];
      const { Item } = await ddb.send(
        new GetCommand({
          TableName: tableName,
          Key: { pk: Put.Item.pk, sk: Put.Item.sk },
          ConsistentRead: true,
        }),
      );
      if (operation === 'delete') expect(Item).toBeUndefined();
      else expect(Item.agentAuthTtl).toBe(ttl);
      expect(await repository.loadInventory({ source: 'space', projectId: 'p1' })).toEqual([]);
    },
  );

  it.each([
    ['claude', 'bedrock', 'kiroApiKey', 'kiro'],
    ['kiro', 'kiro', 'bedrockBearerToken', 'bedrock'],
  ])(
    'selects only %s through the metadata broker while the other provider is locked',
    async (cli, provider, field, blocked) => {
      const { tableName, repository, service } = await setup();
      const candidate = credentialUpdateCandidate({
        source: 'platform',
        update: { [field]: 'rotated' },
      });
      const review = await service.preview(candidate, 'admin');
      await expect(
        service.apply(review.id, 'admin', {
          candidate,
          writeCredentials: async () => {
            throw new Error('interrupted');
          },
        }),
      ).rejects.toThrow('interrupted');
      const reads = [];
      const ssm = {
        send: async (command) => {
          const names = command.input.Names;
          reads.push(...names);
          return { Parameters: names.map((Name) => ({ Name, Value: 'configured' })) };
        },
      };
      const resolveBindings = vi.fn(
        async (request) =>
          (
            await inspectAgentCredentialMetadata(
              {
                action: 'resolve-effective-agent-credential-bindings',
                ...request,
              },
              {
                ddbClient: ddb,
                ssmClient: ssm,
                env: { V2_PROCESS_TABLE: tableName, AGENT_SETTINGS_SSM_PREFIX: '/review/test' },
              },
            )
          ).bindings,
      );
      const result = await resolveSelectedAgentCredential({ agentCli: cli }, { resolveBindings });
      expect(result.provider).toBe(provider);
      expect(resolveBindings).toHaveBeenCalledWith({
        projectId: undefined,
        userId: undefined,
        providers: [provider],
        reserve: true,
      });
      const selections = (await repository.scanInventory()).filter(
        (row) => row.type === 'AgentSelection',
      );
      expect(selections).toHaveLength(1);
      expect(selections[0].credentialBinding.provider).toBe(provider);
      expect(
        reads.every(
          (name) => !name.includes(blocked === 'kiro' ? 'kiro-api-key' : 'bedrock-bearer-token'),
        ),
      ).toBe(true);
      await expect(
        resolveSelectedAgentCredential(
          { agentCli: blocked === 'kiro' ? 'kiro' : 'claude' },
          { resolveBindings },
        ),
      ).rejects.toMatchObject({ code: 'AGENT_AUTH_CHANGE_IN_PROGRESS' });
    },
  );

  it('does not consult a Bedrock mode strategy when selecting Kiro, and discovery creates no reservations', async () => {
    const { repository } = await setup();
    const strategy = vi.fn(() => {
      throw new Error('must not run');
    });
    const resolveLegacy = vi.fn(async () => ({
      bedrock: null,
      kiro: { provider: 'kiro', source: 'platform' },
    }));
    const selected = await resolvePolicyBindings({
      repository,
      resolveLegacy,
      providers: ['kiro'],
      strategies: { keys: strategy },
    });
    expect(selected).toEqual({ kiro: { provider: 'kiro', source: 'platform' } });
    expect(strategy).not.toHaveBeenCalled();
    await resolvePolicyBindings({
      repository,
      resolveLegacy,
      providers: ['bedrock', 'kiro'],
      reserve: false,
    });
    expect(
      (await repository.scanInventory()).filter((row) => row.type === 'AgentSelection'),
    ).toHaveLength(0);
  });

  it('queries only the personal scope and keeps unrelated work and configuration out of the fingerprint', async () => {
    const { repository, service, calls, tableName } = await setup();
    await repository.claimSelection(0, {
      projectId: 'p1',
      bindings: { bedrock: { provider: 'bedrock', source: 'user', userId: 'u1' } },
    });
    await repository.claimSelection(0, {
      projectId: 'p2',
      bindings: { bedrock: { provider: 'bedrock', source: 'user', userId: 'u2' } },
    });
    calls.length = 0;
    const candidate = credentialUpdateCandidate({
      source: 'user',
      userId: 'u1',
      update: { bedrockBearerToken: 'new' },
    });
    const review = await service.preview(candidate, 'u1');
    expect(review.items).toHaveLength(1);
    expect(review.items[0].binding.userId).toBe('u1');
    expect(calls.some((command) => command instanceof ScanCommand)).toBe(false);
    expect(
      calls
        .filter((command) => command instanceof QueryCommand)
        .every(
          (command) => command.input.ExpressionAttributeValues[':pk'] === 'AGENTAUTH#SCOPE#user#u1',
        ),
    ).toBe(true);
    expect(
      calls
        .filter((command) => command instanceof GetCommand)
        .some((command) => command.input.Key.pk.includes('u2')),
    ).toBe(false);
    const unrelated = credentialUpdateCandidate({
      source: 'space',
      projectId: 'p2',
      update: { kiroApiKey: 'new' },
    });
    const otherReview = await service.preview(unrelated, 'admin');
    await service.apply(otherReview.id, 'admin', {
      candidate: unrelated,
      writeCredentials: async () => {},
    });
    await repository.claimSelection(0, {
      projectId: 'p2',
      bindings: { kiro: { provider: 'kiro', source: 'space' } },
    });
    const again = await service.preview(candidate, 'u1');
    expect(again.inventoryHash).toBe(review.inventoryHash);
    expect(again.policyRevision).toBe(review.policyRevision);
    expect(again.activityRevision).toBe(review.activityRevision);
    expect(
      await service.apply(review.id, 'u1', { candidate, writeCredentials: async () => {} }),
    ).toMatchObject({ saved: true });
    expect(tableName).toBeTruthy();
  });

  it('reports re-creating an existing execution as ConditionalCheckFailedException', async () => {
    const tableName = await createAuthTable('auth-review');
    const store = createProcessStore({ ddb, tableName });
    // The intents Lambda writes the DRAFT row; init-ws seeds it again and relies on this name.
    await store.createExecution({ executionId: 'e1', projectId: 'p1', status: 'DRAFT' });
    await expect(
      store.createExecution({ executionId: 'e1', projectId: 'p1', status: 'CREATED' }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
    expect(await store.getExecution('e1', { consistentRead: true })).toMatchObject({
      status: 'DRAFT',
    });
  });

  it('reports a stale binding update as ConditionalCheckFailedException', async () => {
    const tableName = await createAuthTable('auth-review');
    const store = createProcessStore({ ddb, tableName });
    await store.createExecution({ executionId: 'e1', projectId: 'p1', status: 'CREATED' });
    // The start route maps this name to a 409 when a concurrent start won the race.
    await expect(
      store.updateExecution({
        executionId: 'e1',
        projectId: 'p1',
        status: 'CREATED',
        fromStatus: 'DRAFT',
        credentialBinding: { provider: 'bedrock', source: 'platform' },
      }),
    ).rejects.toMatchObject({ name: 'ConditionalCheckFailedException' });
  });

  it('scopes space queries at their partition and atomically indexes new and newly bound executions', async () => {
    const { repository, service, recordingDdb, tableName, calls } = await setup();
    const store = createProcessStore({ ddb: recordingDdb, tableName });
    await store.createExecution({ executionId: 'e1', projectId: 'p1', status: 'DRAFT' });
    await store.createExecution({ executionId: 'e2', projectId: 'p2', status: 'DRAFT' });
    await store.updateExecution({
      executionId: 'e1',
      projectId: 'p1',
      status: 'CREATED',
      credentialBinding: { provider: 'bedrock', source: 'user', userId: 'u1' },
    });
    calls.length = 0;
    const candidate = credentialUpdateCandidate({
      source: 'space',
      projectId: 'p1',
      update: { kiroApiKey: '' },
    });
    const review = await service.preview(candidate, 'admin');
    expect(review.items.map((item) => item.id)).toEqual(['e1']);
    expect(calls.some((command) => command instanceof ScanCommand)).toBe(false);
    const queried = calls
      .filter((command) => command instanceof QueryCommand)
      .map((command) => command.input.ExpressionAttributeValues[':pk']);
    expect(new Set(queried)).toEqual(new Set(['AGENTAUTH#SCOPE#space#p1', 'EXEC#e1']));
    expect(
      (await repository.loadInventory({ source: 'user', userId: 'u1' })).map(
        (row) => row.executionId,
      ),
    ).toEqual(['e1']);
  });

  it('fails closed before the explicit backfill and indexes historical bindings without changing them', async () => {
    const { tableName, recordingDdb } = await setup();
    const { DeleteCommand } = await import('@aws-sdk/lib-dynamodb');
    await ddb.send(
      new DeleteCommand({ TableName: tableName, Key: { pk: 'AGENTAUTH#INVENTORY', sk: 'META' } }),
    );
    const historical = {
      pk: 'EXEC#old',
      sk: 'META',
      type: 'Execution',
      executionId: 'old',
      projectId: 'p1',
      credentialBinding: { provider: 'bedrock', source: 'user', userId: 'u1' },
    };
    await ddb.send(new PutCommand({ TableName: tableName, Item: historical }));
    const repository = createAgentConnectionRepository({ ddb: recordingDdb, tableName });
    await expect(repository.loadInventory({ source: 'user', userId: 'u1' })).rejects.toMatchObject({
      code: 'AGENT_AUTH_INVENTORY_NOT_READY',
    });
    await repository.initializeInventory();
    expect(await repository.loadInventory({ source: 'user', userId: 'u1' })).toEqual([historical]);
    expect(
      (
        await ddb.send(
          new GetCommand({ TableName: tableName, Key: { pk: historical.pk, sk: historical.sk } }),
        )
      ).Item,
    ).toEqual(historical);
  });
});

describe('provider-neutral reviewed domain actions', () => {
  it('atomically creates and selects connections, then restores space inheritance', async () => {
    const { repository, service } = await setup();
    const connection = (id, projectId) => ({
      id,
      revision: 1,
      mode: 'keys',
      backend: 'bedrock',
      mechanism: 'api-key',
      source: projectId ? 'space' : 'platform',
      ...(projectId ? { projectId } : {}),
      configuration: {},
    });
    const activate = async (value) => {
      const review = await service.preview(
        {
          kind: 'connection-create',
          select: true,
          connection: value,
          storage: { secretReference: `/review/test/connections/${value.id}/key` },
        },
        'admin',
      );
      await service.apply(review.id, 'admin');
    };
    await activate(connection('platform-key'));
    await activate(connection('space-key', 'p1'));
    const select = () =>
      resolvePolicyBindings({
        repository,
        projectId: 'p1',
        providers: ['bedrock'],
        resolveLegacy: async () => ({ bedrock: { provider: 'bedrock', source: 'platform' } }),
      });
    expect((await select()).bedrock.connectionId).toBe('space-key');
    const inherit = await service.preview(
      { kind: 'space-selection', source: 'space', projectId: 'p1', connectionId: null },
      'admin',
    );
    await service.apply(inherit.id, 'admin');
    expect((await select()).bedrock.connectionId).toBe('platform-key');
    expect(await repository.getConnection('space-key', 1)).toMatchObject({
      id: 'space-key',
      revision: 1,
    });
    expect((await repository.getPolicy()).revision).toBe(1);
  });
});
