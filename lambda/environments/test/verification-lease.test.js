// Overlapping status polls against the REAL store on DynamoDB Local. The
// status schedule is one minute and the poll may run for its full five-minute
// timeout, so two polls can observe the same VERIFYING revision with no
// validation session yet. Only one of them may mint, invoke and own a session.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import { createEnvironmentStore } from '../store.js';
import { verifyRuntime } from '../status.js';

const TABLE = `env-registry-lease-${process.pid}-${Date.now()}`;
const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: process.env.AWS_REGION || 'us-east-1',
  credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
});
const ddb = DynamoDBDocumentClient.from(client);
const store = createEnvironmentStore({ ddb, tableName: TABLE });

const INSTANCES_ENV = {
  MANAGED_INSTANCES_OPERATOR_ROLE_ARN: 'arn:aws:iam::123456789012:role/operator',
  MANAGED_INSTANCES_SUBNETS: '["subnet-1"]',
  MANAGED_INSTANCES_SECURITY_GROUPS: '["sg-1"]',
};
const environment = {
  environmentId: 'x86-build',
  status: 'VERIFYING',
  compute: { type: 'instances', architecture: 'x86_64' },
};
const CP_ARN = 'arn:aws:bedrock-agentcore:us-east-1:111111111111:capacity-provider/cp-1';

const putVerifyingRevision = async (revisionId) => {
  const item = {
    pk: `ENV#${environment.environmentId}`,
    sk: `REV#${revisionId}`,
    environmentId: environment.environmentId,
    revisionId,
    status: 'VERIFYING',
    runtimeCompatibilityVersion: '1',
    runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/x86',
    runtimeId: 'runtime-1',
    runtimeVersion: '1',
    runtimeEndpoint: `revision_${revisionId}`,
    runtimeEndpointArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime-endpoint/x86',
    capacityProviderArn: CP_ARN,
  };
  await ddb.send(new PutCommand({ TableName: TABLE, Item: item }));
  return item;
};

const readRevision = async (revisionId) =>
  (
    await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { pk: `ENV#${environment.environmentId}`, sk: `REV#${revisionId}` },
      }),
    )
  ).Item;

const transient = () =>
  Object.assign(new Error('instance still provisioning'), { name: 'TimeoutError' });
const cleanupStore = {
  enqueue: vi.fn(),
  listPending: vi.fn().mockResolvedValue([]),
  recordAttempt: vi.fn(),
  remove: vi.fn(),
};
const controlClient = { send: vi.fn().mockResolvedValue({ status: 'READY' }) };

const withEnv = async (fn) => {
  const saved = Object.fromEntries(Object.keys(INSTANCES_ENV).map((k) => [k, process.env[k]]));
  Object.assign(process.env, INSTANCES_ENV);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

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

describe('verification lease on the real store', () => {
  it('two overlapping polls with no session id mint and own exactly one session', async () => {
    const revision = await putVerifyingRevision('r-race');
    let releaseFirstInvoke;
    const firstInvokeBlocked = new Promise((resolve) => {
      releaseFirstInvoke = resolve;
    });
    const invoked = [];
    let firstInvokeStarted;
    const started = new Promise((resolve) => {
      firstInvokeStarted = resolve;
    });
    const runtimeClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name !== 'InvokeAgentRuntimeCommand') return {};
        invoked.push(command.input.runtimeSessionId);
        if (invoked.length === 1) {
          firstInvokeStarted();
          await firstInvokeBlocked;
        }
        throw transient();
      }),
    };
    const poll = () =>
      withEnv(() =>
        verifyRuntime({
          store,
          environment,
          revision,
          controlClient,
          runtimeClient,
          cleanupStore,
        }),
      );

    // Poll A is mid-invoke (the EC2 instance is booting) when poll B starts
    // from the same stale read: no validationSessionId on either.
    const pollA = poll();
    await started;
    const pollB = await poll();
    releaseFirstInvoke();
    const resultA = await pollA;

    expect(pollB).toMatchObject({ pending: true, leaseHeld: false });
    expect(resultA.pending).toBe(true);
    expect(new Set(invoked).size).toBe(1);
    const persisted = await readRevision('r-race');
    expect(persisted.validationSessionId).toBe(invoked[0]);
    expect(persisted.validationAttempts).toBe(1);
    // The lease was handed back.
    expect(persisted.verificationLeaseOwner).toBeUndefined();

    // Both polls hit transient errors; the next poll reattaches to the one
    // session, and when it completes that is the session that gets deleted.
    const capabilities = JSON.stringify({ ok: true, clis: ['claude'] });
    const deterministic = JSON.stringify({
      ok: true,
      nonce: 'check-r-race',
      compatibilityVersion: '1',
      nonRoot: true,
    });
    const healthy = {
      send: vi
        .fn()
        .mockResolvedValueOnce({ response: { transformToString: async () => capabilities } })
        .mockResolvedValueOnce({ response: { transformToString: async () => deterministic } })
        .mockResolvedValue({}),
    };
    const done = await withEnv(() =>
      verifyRuntime({
        store,
        environment,
        revision: persisted,
        controlClient,
        runtimeClient: healthy,
        cleanupStore,
      }),
    );
    expect(done.revision.status).toBe('READY');
    expect(healthy.send.mock.calls[0][0].input.runtimeSessionId).toBe(invoked[0]);
    const deletes = healthy.send.mock.calls.filter(
      (call) => call[0].constructor.name === 'DeleteCapacityProviderSessionCommand',
    );
    expect(deletes.map((call) => call[0].input.sessionId)).toEqual([invoked[0]]);
    expect((await readRevision('r-race')).validationSessionId).toBeNull();
  });

  it('an expired lease can be taken over; a stale owner cannot release the new one', async () => {
    await putVerifyingRevision('r-expiry');
    const crashed = await store.acquireVerificationLease('x86-build', 'r-expiry', {
      owner: 'crashed-poll',
      ttlMs: -1,
    });
    expect(crashed).not.toBeNull();
    const next = await store.acquireVerificationLease('x86-build', 'r-expiry', {
      owner: 'next-poll',
      ttlMs: 60_000,
    });
    expect(next.verificationLeaseOwner).toBe('next-poll');
    await store.releaseVerificationLease('x86-build', 'r-expiry', 'crashed-poll');
    expect((await readRevision('r-expiry')).verificationLeaseOwner).toBe('next-poll');
    expect(
      await store.acquireVerificationLease('x86-build', 'r-expiry', {
        owner: 'third',
        ttlMs: 60_000,
      }),
    ).toBeNull();
  });

  it('only a VERIFYING revision can be leased', async () => {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { pk: 'ENV#x86-build', sk: 'REV#r-ready', revisionId: 'r-ready', status: 'READY' },
      }),
    );
    expect(
      await store.acquireVerificationLease('x86-build', 'r-ready', { owner: 'p', ttlMs: 60_000 }),
    ).toBeNull();
  });
});
