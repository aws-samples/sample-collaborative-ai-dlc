import { SendMessageCommand } from '@aws-sdk/client-sqs';
import { QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { createNativeRuntimeLambda } from '../command-service.js';
import {
  ACTOR,
  DEPLOYMENT,
  IDENTITY,
  IMAGE,
  MEMBERSHIP,
  PROJECT,
  TABLE,
  binding,
  createInput,
  event,
  job,
  setup,
} from './fixtures.js';

const environment = {
  NATIVE_PREPARATION_ENABLED: 'true',
  NATIVE_PREPARATION_PROJECT_IDS: JSON.stringify([PROJECT]),
  NATIVE_RUNTIME_BINDINGS_TABLE: TABLE,
  NATIVE_RUNTIME_ACCOUNT_ID: DEPLOYMENT.accountId,
  AWS_REGION: DEPLOYMENT.region,
  AWS_PARTITION: DEPLOYMENT.partition,
  NATIVE_RUNTIME_FILE_SYSTEM_ID: DEPLOYMENT.fileSystemId,
  NATIVE_RUNTIME_IMAGE_URI: IMAGE.uri,
  NATIVE_RUNTIME_IMAGE_DIGEST: IMAGE.digest,
  NATIVE_PACKAGE_JOBS_TABLE: 'protected-package-jobs',
  NATIVE_RUNTIME_QUEUE_URL: 'https://sqs.us-east-1.amazonaws.com/123456789012/native-queue',
};
const fixture = (overrides = {}) => {
  const f = setup();
  const connection = { close: vi.fn(async () => {}) };
  const openConnection = vi.fn(async () => connection);
  const membershipSnapshot = vi.fn(async () => MEMBERSHIP);
  const sourceFactory = vi.fn(() => ({ getAuthorizedBinding: vi.fn(async () => binding()) }));
  const jobsFactory = vi.fn(() => ({ get: vi.fn(async () => job()) }));
  const sqs = { send: vi.fn(async () => ({ MessageId: 'message-one' })) };
  const handler = createNativeRuntimeLambda({
    ddb: f.ddb,
    sqs,
    env: environment,
    openConnection,
    membershipSnapshot,
    sourceFactory,
    jobsFactory,
    storeFactory: () => f.store,
    ...overrides,
  });
  return {
    ...f,
    connection,
    openConnection,
    membershipSnapshot,
    sourceFactory,
    jobsFactory,
    sqs,
    handler,
  };
};

describe('native REST host and SQS boundary', () => {
  it.each([
    { NATIVE_PREPARATION_ENABLED: 'false' },
    { NATIVE_PREPARATION_PROJECT_IDS: PROJECT },
    { NATIVE_PREPARATION_PROJECT_IDS: '{}' },
    { NATIVE_PREPARATION_PROJECT_IDS: undefined },
  ])(
    'does no graph/storage/queue work for disabled or malformed configuration %j',
    async (changed) => {
      const f = fixture({ env: { ...environment, ...changed } });
      expect((await f.handler(event())).statusCode).toBe(
        changed.NATIVE_PREPARATION_ENABLED ? 503 : 403,
      );
      expect(f.openConnection).not.toHaveBeenCalled();
      expect(f.ddb.send).not.toHaveBeenCalled();
      expect(f.sourceFactory).not.toHaveBeenCalled();
      expect(f.sqs.send).not.toHaveBeenCalled();
    },
  );

  it('serves capabilities using only the existing member lookup and closes its connection', async () => {
    const f = fixture();
    const response = await f.handler(event('capabilities'));
    expect(JSON.parse(response.body)).toEqual({
      preparationEnabled: true,
      executionEnabled: false,
      unavailableHarnesses: { kiro: 'NATIVE_EXECUTION_KIRO_UNAVAILABLE' },
    });
    expect(f.openConnection).toHaveBeenCalledTimes(1);
    expect(f.membershipSnapshot).toHaveBeenCalledWith(expect.anything(), PROJECT, ACTOR);
    expect(f.connection.close).toHaveBeenCalledTimes(1);
    expect(f.sourceFactory).not.toHaveBeenCalled();
    expect(f.jobsFactory).not.toHaveBeenCalled();
    expect(f.ddb.send).not.toHaveBeenCalled();
    expect(f.sqs.send).not.toHaveBeenCalled();
  });

  it('wires native listing to the protected index and existing validated store, then closes Neptune', async () => {
    const f = fixture();
    const { row } = await f.store.create(createInput());
    f.ddb.send.mockClear();
    f.ddb.send.mockResolvedValueOnce({
      Items: [
        Object.fromEntries(
          ['pk', 'sk', 'projectId', 'createdAt', 'executionId'].map((key) => [key, row[key]]),
        ),
      ],
    });
    const response = await f.handler(
      event('capabilities', { queryStringParameters: { view: 'list' } }),
    );
    expect(response.statusCode).toBe(200);
    expect(JSON.parse(response.body)).toMatchObject({
      items: [{ id: IDENTITY.executionId, projectId: PROJECT, executionBackend: 'native' }],
      nextCursor: null,
    });
    expect(response.body).not.toContain(row.request.prompt);
    expect(f.ddb.send.mock.calls[0][0]).toBeInstanceOf(QueryCommand);
    expect(f.ddb.send.mock.calls[0][0].input.TableName).toBe(TABLE);
    expect(f.membershipSnapshot).toHaveBeenCalledTimes(2);
    expect(f.connection.close).toHaveBeenCalledTimes(1);
    expect(f.sourceFactory).not.toHaveBeenCalled();
    expect(f.jobsFactory).not.toHaveBeenCalled();
    expect(f.sqs.send).not.toHaveBeenCalled();
  });

  it('uses no source-credential ports and sends only the protected identity pointer to configured SQS', async () => {
    const f = fixture();
    expect((await f.handler(event())).statusCode).toBe(201);
    expect(Object.keys(f.sourceFactory.mock.calls[0][0]).toSorted()).toEqual([
      'ddb',
      'getMembershipSnapshot',
    ]);
    expect(f.jobsFactory).toHaveBeenCalledWith({ ddb: f.ddb, tableName: 'protected-package-jobs' });
    expect((await f.handler(event('prepare'))).statusCode).toBe(202);
    expect(f.sqs.send).toHaveBeenCalledTimes(1);
    const command = f.sqs.send.mock.calls[0][0];
    expect(command).toBeInstanceOf(SendMessageCommand);
    expect(command.input).toEqual({
      QueueUrl: environment.NATIVE_RUNTIME_QUEUE_URL,
      MessageBody: JSON.stringify(IDENTITY),
    });
    expect(f.connection.close).toHaveBeenCalledTimes(2);
  });

  it('accepts durable preparation despite a missing fast notification acknowledgement', async () => {
    const f = fixture();
    await f.handler(event());
    f.sqs.send.mockResolvedValue({});
    const response = await f.handler(event('prepare'));
    expect(response.statusCode).toBe(202);
    expect(f.read().status).toBe('PREPARING');
  });

  it('redacts graph open and close errors', async () => {
    const f = fixture();
    f.openConnection.mockRejectedValueOnce(new Error('private Neptune credentials'));
    const first = await f.handler(event('capabilities'));
    expect(first.statusCode).toBe(500);
    expect(first.body).not.toContain('private');
    f.connection.close.mockRejectedValueOnce(new Error('private socket'));
    const second = await f.handler(event('capabilities'));
    expect(second.statusCode).toBe(500);
    expect(second.body).not.toContain('private');
  });
});
