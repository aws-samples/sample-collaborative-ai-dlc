import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { DynamoDBClient, CreateTableCommand, DeleteTableCommand } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  BatchWriteCommand,
  GetCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { createAgentConnectionRepository } from '../agent-connection-repository.js';
import {
  createAgentAuthChangeService,
  credentialUpdateCandidate,
  materialAuthInventory,
  classifyAuthImpact,
} from '../agent-auth-changes.js';
import { resolvePolicyBindings, connectionBinding } from '../agent-binding-selection.js';
import { redeemAgentBinding } from '../agent-auth-redemption.js';
import { createOAuthStateRepository } from '../agent-oauth-state-repository.js';
import { createOAuthCredentialCoordinator } from '../agent-oauth-contract.js';
import { normalizeConnection, connectionAudience } from '../agent-auth-catalog.js';

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const ddb = DynamoDBDocumentClient.from(client, {
  marshallOptions: { removeUndefinedValues: true },
});
const tables = [];
const table = async () => {
  const TableName = `agent-auth-${randomUUID()}`;
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
beforeAll(() => {
  if (!process.env.DYNAMODB_LOCAL_ENDPOINT) throw new Error('DynamoDB Local is required');
});
afterAll(async () => {
  await Promise.all(tables.map((TableName) => client.send(new DeleteTableCommand({ TableName }))));
  client.destroy();
});
const policyCandidate = {
  kind: 'policy',
  mode: 'keys',
  defaultConnectionId: 'legacy-platform-bedrock',
};

describe('revision-safe authentication changes with DynamoDB', () => {
  it('enumerates every scan page and rechecks discovered records authoritatively', async () => {
    const stale = {
      pk: 'EXEC#stale',
      sk: 'META',
      type: 'Execution',
      executionId: 'stale',
      status: 'RUNNING',
    };
    const second = { ...stale, pk: 'EXEC#second', executionId: 'second' };
    const send = vi.fn(async (command) => {
      if (command instanceof ScanCommand)
        return command.input.ExclusiveStartKey
          ? { Items: [second] }
          : { Items: [stale], LastEvaluatedKey: { pk: stale.pk, sk: stale.sk } };
      if (command instanceof GetCommand)
        return {
          Item: command.input.Key.pk === stale.pk ? { ...stale, status: 'WAITING' } : second,
        };
      throw new Error('Unexpected command');
    });
    const repository = createAgentConnectionRepository({ ddb: { send }, tableName: 'inventory' });
    const inventory = await repository.scanInventory();
    expect(inventory.map((item) => item.status)).toEqual(['WAITING', 'RUNNING']);
    expect(send.mock.calls.filter(([command]) => command instanceof ScanCommand)).toHaveLength(2);
    expect(send.mock.calls.every(([command]) => command.input.ConsistentRead === true)).toBe(true);
  });
  it('includes each identity used by model discovery and derives auxiliary scope from its parent', () => {
    const inventory = materialAuthInventory([
      {
        pk: 'EXEC#e1',
        sk: 'META',
        type: 'Execution',
        executionId: 'e1',
        projectId: 'p1',
        agentCli: 'claude',
        credentialBinding: { provider: 'bedrock', source: 'space' },
      },
      { pk: 'EXEC#e1', sk: 'COMPOSE#c1', type: 'Compose', executionId: 'e1', state: 'RUNNING' },
      {
        pk: 'AGENTAUTH#INVOCATION#discovery',
        sk: 'META',
        type: 'AgentInvocation',
        projectId: 'p1',
        heartbeatAt: new Date().toISOString(),
        credentialBindings: [
          { provider: 'bedrock', source: 'space' },
          { provider: 'kiro', source: 'space' },
        ],
      },
    ]);
    expect(inventory.find((item) => item.type === 'Compose')).toMatchObject({
      projectId: 'p1',
      binding: { provider: 'bedrock', source: 'space' },
    });
    const impact = classifyAuthImpact(
      inventory,
      credentialUpdateCandidate({ source: 'space', projectId: 'p1', update: { kiroApiKey: '' } }),
    );
    expect(impact.filter((item) => item.outcome === 'loses-access')).toHaveLength(1);
    expect(impact.find((item) => item.outcome === 'loses-access').binding.provider).toBe('kiro');
  });
  it('inventories more than 100 executions, drafts, failed work and auxiliary invocations', async () => {
    const tableName = await table();
    const records = Array.from({ length: 135 }, (_, index) => ({
      pk: `EXEC#e${index}`,
      sk: 'META',
      type: 'Execution',
      executionId: `e${index}`,
      projectId: 'p1',
      status: ['RUNNING', 'WAITING', 'FAILED', 'CREATED', 'DRAFT'][index % 5],
      ...(index % 5 === 4
        ? {}
        : { agentCli: 'claude', credentialBinding: { provider: 'bedrock', source: 'space' } }),
    }));
    records.push({
      pk: 'AGENTAUTH#INVOCATION#aux',
      sk: 'META',
      type: 'AgentInvocation',
      executionId: 'e2',
      projectId: 'p1',
      state: 'ACTIVE',
      credentialBinding: { provider: 'bedrock', source: 'space' },
    });
    for (let index = 0; index < records.length; index += 25) {
      await ddb.send(
        new BatchWriteCommand({
          RequestItems: {
            [tableName]: records.slice(index, index + 25).map((Item) => ({ PutRequest: { Item } })),
          },
        }),
      );
    }
    const repository = createAgentConnectionRepository({ ddb, tableName, base: '/app/test' });
    const service = createAgentAuthChangeService({ repository });
    const review = await service.preview(
      credentialUpdateCandidate({
        source: 'space',
        projectId: 'p1',
        update: { bedrockBearerToken: '' },
      }),
      'admin',
    );
    expect(review.items).toHaveLength(136);
    expect(review.counts['next-start']).toBe(27);
    expect(review.counts['loses-access']).toBe(109);
    expect(review.complete).toBe(false);
    expect(review.items.find((item) => item.id === 'e2' && item.type === 'Execution').status).toBe(
      'FAILED',
    );
    expect((await repository.getReview(review.id)).items).toBeUndefined();
  });
  it('rejects new work and concurrent selection after a review, with no partial activation', async () => {
    const tableName = await table();
    const repository = createAgentConnectionRepository({ ddb, tableName, base: '/app/test' });
    const service = createAgentAuthChangeService({ repository });
    const review = await service.preview(policyCandidate, 'admin');
    await ddb.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          pk: 'EXEC#new',
          sk: 'META',
          type: 'Execution',
          executionId: 'new',
          status: 'DRAFT',
        },
      }),
    );
    await expect(service.apply(review.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    const fresh = await service.preview(policyCandidate, 'admin');
    await repository.claimSelection(0);
    await expect(service.apply(fresh.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    expect((await repository.getPolicy()).revision).toBe(0);
  });
  it('conditionally applies a reviewed policy, preserves old references, and handles duplicate submission', async () => {
    const repository = createAgentConnectionRepository({
      ddb,
      tableName: await table(),
      base: '/app/test',
    });
    const service = createAgentAuthChangeService({ repository });
    const review = await service.preview(policyCandidate, 'admin');
    await expect(service.apply(review.id, 'other')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_INVALID',
    });
    expect(await service.apply(review.id, 'admin')).toEqual({ saved: true, revision: 1 });
    expect(await service.apply(review.id, 'admin')).toEqual({ saved: true, revision: 1 });
    expect((await repository.getConnection('legacy-space-bedrock-p1', 0)).secretReference).toBe(
      '/app/test/projects/p1/agent-credentials/bedrock-bearer-token',
    );
    expect((await repository.getPolicy()).mode).toBe('keys');
    await expect(
      service.preview({ ...policyCandidate, mode: 'litellm' }, 'admin'),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_MODE_UNAVAILABLE' });
  });
  it('detects a policy race between inventory recheck and the transaction', async () => {
    const repository = createAgentConnectionRepository({
      ddb,
      tableName: await table(),
      base: '/app/test',
    });
    const service = createAgentAuthChangeService({ repository });
    const review = await service.preview(policyCandidate, 'admin');
    const apply = repository.applyReview;
    repository.applyReview = async (request) => {
      await repository.claimSelection(0);
      return apply(request);
    };
    await expect(service.apply(review.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    expect((await repository.getPolicy()).revision).toBe(0);
  });
  it('binds secret updates to the review and safely retries a failed write', async () => {
    const repository = createAgentConnectionRepository({
      ddb,
      tableName: await table(),
      base: '/app/test',
    });
    const service = createAgentAuthChangeService({ repository });
    const candidate = credentialUpdateCandidate({
      source: 'platform',
      update: { bedrockBearerToken: 'new-key-for-test' },
    });
    const review = await service.preview(candidate, 'admin');
    expect(JSON.stringify(review)).not.toContain('new-key-for-test');
    await expect(
      service.apply(review.id, 'admin', {
        candidate: { ...candidate, source: 'user' },
        writeCredentials: vi.fn(),
      }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_REVIEW_STALE' });
    const writeCredentials = vi
      .fn()
      .mockRejectedValueOnce(new Error('SSM unavailable'))
      .mockResolvedValueOnce(undefined);
    await expect(
      service.apply(review.id, 'admin', { candidate, writeCredentials }),
    ).rejects.toThrow('SSM unavailable');
    expect((await repository.getPolicy()).pendingReview).toBe(review.id);
    await expect(repository.claimSelection(0)).rejects.toMatchObject({
      name: 'ConditionalCheckFailedException',
    });
    expect(await service.apply(review.id, 'admin', { candidate, writeCredentials })).toEqual({
      saved: true,
      revision: 1,
    });
    expect((await repository.getPolicy()).pendingReview).toBeUndefined();
    expect(await service.apply(review.id, 'admin', { candidate, writeCredentials })).toEqual({
      saved: true,
      revision: 1,
    });
    expect(writeCredentials).toHaveBeenCalledTimes(2);
  });
  it('holds only the affected credential while an interrupted write is retried', async () => {
    const repository = createAgentConnectionRepository({
      ddb,
      tableName: await table(),
      base: '/app/test',
    });
    const service = createAgentAuthChangeService({ repository });
    const candidate = credentialUpdateCandidate({
      source: 'user',
      userId: 'u1',
      update: { bedrockBearerToken: 'replacement' },
    });
    const review = await service.preview(candidate, 'u1');
    await expect(
      service.apply(review.id, 'u1', {
        candidate,
        writeCredentials: async () => {
          throw new Error('SSM unavailable');
        },
      }),
    ).rejects.toThrow('SSM unavailable');
    const resolve = (userId) =>
      resolvePolicyBindings({
        repository,
        projectId: 'p1',
        userId,
        reserve: true,
        resolveLegacy: async () => ({ bedrock: { provider: 'bedrock', source: 'user', userId } }),
      });
    await expect(resolve('u1')).rejects.toMatchObject({ code: 'AGENT_AUTH_CHANGE_IN_PROGRESS' });
    expect((await resolve('u2')).bedrock.userId).toBe('u2');
    expect((await service.preview(candidate, 'u1')).id).toBe(review.id);
    expect(
      await service.apply(review.id, 'u1', { candidate, writeCredentials: async () => {} }),
    ).toEqual({ saved: true, revision: 1 });
    expect((await repository.getPolicy()).activityRevision).toBe(1);
  });
  it('retains immutable definitions for pinned work and honors explicit revocation', async () => {
    const repository = createAgentConnectionRepository({
      ddb,
      tableName: await table(),
      base: '/app/test',
    });
    const connection = {
      id: 'key-connection',
      revision: 1,
      mode: 'keys',
      backend: 'bedrock',
      mechanism: 'api-key',
      source: 'space',
      projectId: 'p1',
      configuration: {},
    };
    const reference = '/app/test/connections/key-connection/api-key';
    await repository.putConnection(connection, reference);
    const binding = connectionBinding(connection, 0);
    const legacyClear = credentialUpdateCandidate({
      source: 'space',
      projectId: 'p1',
      update: { bedrockBearerToken: '' },
    });
    expect(
      classifyAuthImpact([{ type: 'Execution', binding, projectId: 'p1' }], legacyClear)[0].outcome,
    ).toBe('continues');
    const ssm = { send: vi.fn(async () => ({ Parameter: { Value: 'pinned-key' } })) };
    await repository.putConnection({ ...connection, revision: 2, state: 'retired' }, reference);
    expect((await redeemAgentBinding({ binding, projectId: 'p1', repository, ssm })).value).toBe(
      'pinned-key',
    );
    expect((await repository.getConnection(connection.id, 1)).state).toBe('ready');
    expect(ssm.send.mock.calls[0][0].input.Name).toBe(reference);
    await expect(
      redeemAgentBinding({ binding, projectId: 'p2', repository, ssm }),
    ).rejects.toMatchObject({ code: 'AGENT_CREDENTIAL_GRANT_INVALID' });
    await repository.putConnection({ ...connection, revision: 3, state: 'revoked' }, reference);
    await expect(
      redeemAgentBinding({ binding, projectId: 'p1', repository, ssm }),
    ).rejects.toMatchObject({ code: 'AGENT_AUTH_CONNECTION_UNAVAILABLE' });
    expect(ssm.send).toHaveBeenCalledOnce();
  });
});

describe('OAuth refresh across broker instances with durable leases', () => {
  const configuration = {
    endpoint: 'https://gateway.example/v1',
    issuer: 'https://idp.example',
    audience: 'models',
    clientId: 'aidlc',
  };
  const connection = normalizeConnection({
    id: 'shared-oauth',
    revision: 1,
    mode: 'litellm',
    backend: 'litellm',
    mechanism: 'oauth-user',
    source: 'space',
    projectId: 'p1',
    configuration,
  });
  const credential = (suffix, expiresAt) => ({
    ...configuration,
    grantType: 'authorization_code',
    subject: 'shared-user',
    accessToken: `access-${suffix}`,
    refreshToken: `refresh-${suffix}`,
    expiresAt,
  });
  const setup = async () => {
    const stateRepository = createOAuthStateRepository({ ddb, tableName: await table() });
    const secrets = new Map([['secret-1', credential('old', 1)]]);
    const secretRepository = {
      read: async (ref) => secrets.get(ref),
      writeImmutable: async (_id, value) => {
        const ref = `secret-${randomUUID()}`;
        secrets.set(ref, value);
        return ref;
      },
      remove: async (ref) => secrets.delete(ref),
    };
    await stateRepository.establish(connection.id, {
      identity: connectionAudience(connection),
      subject: 'shared-user',
      secretReference: 'secret-1',
      credentialExpiresAt: 1,
    });
    return { stateRepository, secretRepository, secrets };
  };
  it('refreshes a rotating token once and shares the committed result', async () => {
    const deps = await setup();
    let acquired;
    const started = new Promise((resolve) => {
      acquired = resolve;
    });
    let finish;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    const acquire = vi.fn(async () => {
      acquired();
      await pending;
      return credential('new', Date.now() + 3600000);
    });
    const first = createOAuthCredentialCoordinator({ ...deps, acquire, ownerId: 'broker-1' });
    const second = createOAuthCredentialCoordinator({ ...deps, acquire, ownerId: 'broker-2' });
    const a = first.credential(connection);
    await started;
    const b = second.credential(connection);
    finish();
    const [one, two] = await Promise.all([a, b]);
    expect(one.refreshToken).toBe('refresh-new');
    expect(two.accessToken).toBe(one.accessToken);
    expect(acquire).toHaveBeenCalledOnce();
    const state = await deps.stateRepository.read(connection.id);
    expect(state.version).toBe(2);
    expect(JSON.stringify(state)).not.toContain('refresh-new');
    expect(JSON.stringify(state)).not.toContain('access-new');
  });
  it('prevents a refresh from replacing a revoked connection identity', async () => {
    const deps = await setup();
    const acquire = async () => {
      await deps.stateRepository.invalidate(connection.id, 1, 'revoked');
      return credential('new', Date.now() + 3600000);
    };
    const coordinator = createOAuthCredentialCoordinator({ ...deps, acquire, ownerId: 'broker' });
    await expect(coordinator.credential(connection)).rejects.toMatchObject({
      code: 'AGENT_AUTH_REFRESH_CONFLICT',
    });
    expect((await deps.stateRepository.read(connection.id)).status).toBe('revoked');
    expect(deps.secrets.size).toBe(1);
  });
  it('requires reconnect after an uncertain expired refresh lease', async () => {
    const deps = await setup();
    await deps.stateRepository.claim(connection.id, 1, 'crashed-broker', Date.now() - 1000);
    const acquire = vi.fn();
    const coordinator = createOAuthCredentialCoordinator({
      ...deps,
      acquire,
      ownerId: 'new-broker',
    });
    await expect(coordinator.credential(connection)).rejects.toMatchObject({
      code: 'AGENT_AUTH_RECONNECT_REQUIRED',
    });
    expect(acquire).not.toHaveBeenCalled();
  });
  it('coordinates expired machine-identity acquisition without assuming a user refresh token', async () => {
    const machine = normalizeConnection({
      ...connection,
      id: 'machine-oauth',
      mechanism: 'oauth-machine',
    });
    const stateRepository = createOAuthStateRepository({ ddb, tableName: await table() });
    const previous = {
      ...configuration,
      grantType: 'client_credentials',
      subject: 'machine-client',
      accessToken: 'expired',
      expiresAt: 1,
    };
    const secrets = new Map([['machine-old', previous]]);
    const secretRepository = {
      read: async (reference) => secrets.get(reference),
      writeImmutable: async (_id, value) => {
        secrets.set('machine-new', value);
        return 'machine-new';
      },
      remove: async (reference) => secrets.delete(reference),
    };
    await stateRepository.establish(machine.id, {
      identity: connectionAudience(machine),
      subject: previous.subject,
      secretReference: 'machine-old',
      credentialExpiresAt: 1,
    });
    const acquire = vi.fn(async ({ previous: prior }) => {
      expect(prior.refreshToken).toBeUndefined();
      return { ...previous, accessToken: 'machine-renewed', expiresAt: Date.now() + 3600000 };
    });
    const credentials = await Promise.all(
      ['machine-broker-1', 'machine-broker-2'].map((ownerId) =>
        createOAuthCredentialCoordinator({
          stateRepository,
          secretRepository,
          acquire,
          ownerId,
        }).credential(machine),
      ),
    );
    expect(credentials.map((item) => item.accessToken)).toEqual([
      'machine-renewed',
      'machine-renewed',
    ]);
    expect(acquire).toHaveBeenCalledOnce();
  });
});

describe('reviewed IAM activation on the foundation', () => {
  const iam = (id, projectId) =>
    normalizeConnection({
      id,
      revision: 1,
      mode: 'iam',
      backend: 'bedrock',
      mechanism: 'assume-role',
      source: projectId ? 'space' : 'platform',
      projectId,
      configuration: {
        roleArn: `arn:aws:iam::222222222222:role/${id}`,
        region: 'eu-west-1',
        externalId: 'external-fixture',
      },
    });
  it('atomically activates a platform connection, selects a space override, and restores inheritance', async () => {
    const repository = createAgentConnectionRepository({ ddb, tableName: await table() });
    const service = createAgentAuthChangeService({ repository });
    const platform = iam('iam-platform');
    const space = iam('iam-space', 'p1');
    const review = await service.preview({ kind: 'iam-connection', connection: platform }, 'admin');
    expect(await repository.getConnection(platform.id)).toBeNull();
    expect((await repository.getPolicy()).mode).toBe('keys');
    await service.apply(review.id, 'admin');
    expect(await repository.getConnection(platform.id, 1)).toMatchObject(platform);
    expect((await repository.getPolicy()).defaultConnectionId).toBe(platform.id);
    const keys = {
      bedrock: { provider: 'bedrock', source: 'user', userId: 'u1' },
      kiro: { provider: 'kiro', source: 'user', userId: 'u1' },
    };
    const resolve = () =>
      resolvePolicyBindings({
        repository,
        projectId: 'p1',
        userId: 'u1',
        resolveLegacy: async () => ({ ...keys }),
      });
    expect(await resolve()).toEqual({ bedrock: connectionBinding(platform, 1), kiro: keys.kiro });
    const spaceReview = await service.preview(
      { kind: 'iam-connection', connection: space },
      'admin',
    );
    await service.apply(spaceReview.id, 'admin');
    expect((await resolve()).bedrock).toEqual(connectionBinding(space, 2));
    const inherit = await service.preview({ kind: 'space-inherit', projectId: 'p1' }, 'admin');
    await service.apply(inherit.id, 'admin');
    expect((await resolve()).bedrock).toEqual(connectionBinding(platform, 3));
    expect(await repository.getConnection(space.id, 1)).toMatchObject(space);
    await service.apply(inherit.id, 'admin');
    expect((await repository.getPolicy()).revision).toBe(3);
  });
  it('rejects a stale IAM activation without leaving a connection or changing selection', async () => {
    const repository = createAgentConnectionRepository({ ddb, tableName: await table() });
    const service = createAgentAuthChangeService({ repository });
    const connection = iam('iam-stale');
    const review = await service.preview({ kind: 'iam-connection', connection }, 'admin');
    await repository.claimSelection(0);
    await expect(service.apply(review.id, 'admin')).rejects.toMatchObject({
      code: 'AGENT_AUTH_REVIEW_STALE',
    });
    expect(await repository.getConnection(connection.id)).toBeNull();
    expect((await repository.getPolicy()).mode).toBe('keys');
  });
});
