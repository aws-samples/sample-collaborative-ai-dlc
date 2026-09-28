import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  ScanCommand,
  GetCommand,
} from '@aws-sdk/lib-dynamodb';
import { createAgentConnectionRepository } from '../agent-connection-repository.js';
import { createAgentAuthChangeService, credentialUpdateCandidate } from '../agent-auth-changes.js';
import { resolveSelectedAgentCredential } from '../agent-credential-service.js';
import { resolvePolicyBindings } from '../agent-binding-selection.js';
import { inspectAgentCredentialMetadata } from '../../credential-metadata/index.js';
import { createProcessStore } from '../v2-process-store.js';

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const tables = [];
beforeAll(() => {
  if (!process.env.DYNAMODB_LOCAL_ENDPOINT) throw new Error('DynamoDB Local is required');
});
afterAll(async () => {
  await Promise.all(tables.map((TableName) => client.send(new DeleteTableCommand({ TableName }))));
  client.destroy();
});
const setup = async () => {
  const tableName = `auth-review-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: tableName,
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
  tables.push(tableName);
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
