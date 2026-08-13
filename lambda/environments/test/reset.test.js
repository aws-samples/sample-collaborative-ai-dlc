import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  claimResetExecution,
  createResetHandler,
  executeReset,
  recoverStaleMarker,
  relevantRegistryItems,
} from '../reset.js';

const graph = (projects = []) => {
  const chain = {
    V: vi.fn(() => chain),
    hasLabel: vi.fn(() => chain),
    has: vi.fn(() => chain),
    project: vi.fn(() => chain),
    by: vi.fn(() => chain),
    property: vi.fn(() => chain),
    toList: vi.fn().mockResolvedValue(
      projects.map(
        ({ projectId, environmentId }) =>
          new Map([
            ['projectId', projectId],
            ['environmentId', environmentId],
          ]),
      ),
    ),
    iterate: vi.fn().mockResolvedValue(undefined),
  };
  return chain;
};

const documentClient = ({ marker = null } = {}) => ({
  send: vi.fn().mockImplementation(async (command) => {
    if (command.constructor.name === 'GetCommand') return { Item: marker };
    if (['PutCommand', 'UpdateCommand', 'BatchWriteCommand'].includes(command.constructor.name)) {
      return {};
    }
    throw new Error(`Unsupported command ${command.constructor.name}`);
  }),
});

const claims = {
  requestContext: {
    authorizer: {
      claims: {
        sub: 'user-1',
        email: 'admin@example.com',
        'cognito:groups': 'platform-admin',
      },
    },
  },
};

describe('managed environment reset', () => {
  beforeEach(() => {
    vi.stubEnv('ENVIRONMENT_REGISTRY_TABLE', 'registry');
    vi.stubEnv('ENVIRONMENT_ECR_REPOSITORY_NAME', 'environments');
  });

  it('retains orphan revision lookups for cleanup after a partial deletion', () => {
    const relevant = relevantRegistryItems([
      {
        pk: 'ENV#legacy-go',
        sk: 'REV#r-1',
        type: 'EnvironmentRevision',
        environmentId: 'legacy-go',
        revisionId: 'r-1',
      },
      {
        pk: `IMAGE#sha256:${'a'.repeat(64)}`,
        sk: 'LOOKUP',
        environmentId: 'legacy-go',
        revisionId: 'r-1',
      },
    ]);

    expect([...relevant.environmentIds]).toEqual(['legacy-go']);
    expect(relevant.items).toHaveLength(2);
  });

  it('reassigns projects, cancels active sessions, and removes non-Standard artifacts', async () => {
    const g = graph([{ projectId: 'p-1', environmentId: 'legacy-rust' }]);
    const store = {
      scanRegistry: vi.fn().mockResolvedValue([
        {
          pk: 'ENV#standard',
          sk: 'META',
          type: 'Environment',
          environmentId: 'standard',
        },
        {
          pk: 'ENV#legacy-rust',
          sk: 'META',
          type: 'Environment',
          environmentId: 'legacy-rust',
        },
        {
          pk: 'ENV#legacy-rust',
          sk: 'REV#r-1',
          type: 'EnvironmentRevision',
          environmentId: 'legacy-rust',
          revisionId: 'r-1',
        },
        {
          pk: `IMAGE#sha256:${'a'.repeat(64)}`,
          sk: 'LOOKUP',
          environmentId: 'legacy-rust',
          revisionId: 'r-1',
        },
      ]),
    };
    const meta = {
      executionId: 'intent-1',
      projectId: 'p-1',
      status: 'RUNNING',
      startedAt: '2026-08-13T00:00:00.000Z',
      environment: {
        environmentId: 'legacy-rust',
        runtimeArn: 'arn:aws:bedrock-agentcore:us-east-1:111111111111:runtime/runtime-1',
        runtimeEndpoint: 'revision_r_1',
      },
    };
    const processStore = {
      listActiveExecutions: vi.fn().mockResolvedValue([meta]),
      getExecutionRecords: vi.fn().mockResolvedValue({
        units: [{ sectionIndex: 0, slug: 'implementation' }],
      }),
      updateExecution: vi.fn().mockResolvedValue({}),
      appendEvent: vi.fn().mockResolvedValue({}),
    };
    const ecrClient = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'ListImagesCommand') {
          return { imageIds: [{ imageDigest: `sha256:${'b'.repeat(64)}` }] };
        }
        if (command.constructor.name === 'BatchDeleteImageCommand') return {};
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    const runtimeClient = { send: vi.fn().mockResolvedValue({}) };
    const ddb = documentClient();

    const result = await executeReset({
      g,
      actor: 'admin@example.com',
      store,
      process: processStore,
      documentClient: ddb,
      ecrClient,
      controlClient: { send: vi.fn() },
      runtimeClient,
      lambdaClient: { send: vi.fn() },
    });

    expect(result).toEqual({
      projectsReassigned: 1,
      intentsCancelled: 1,
      environmentsDeleted: 1,
      revisionsDeleted: 1,
      runtimesDeleted: 0,
      imagesDeleted: 1,
    });
    expect(g.property).toHaveBeenCalledWith(expect.anything(), 'environment_id', 'standard');
    expect(runtimeClient.send).toHaveBeenCalledTimes(2);
    expect(processStore.updateExecution).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'intent-1',
        status: 'CANCELLED',
        failureReason: 'managed_environment_reset',
      }),
    );
    const registryDelete = ddb.send.mock.calls.find(
      ([command]) => command.constructor.name === 'BatchWriteCommand',
    );
    expect(registryDelete[0].input.RequestItems).toMatchObject({
      [process.env.ENVIRONMENT_REGISTRY_TABLE]: expect.arrayContaining([
        { DeleteRequest: { Key: { pk: 'ENV#legacy-rust', sk: 'META' } } },
        { DeleteRequest: { Key: { pk: 'ENV#legacy-rust', sk: 'REV#r-1' } } },
      ]),
    });
  });

  it('returns the recorded result without repeating a completed reset', async () => {
    const result = {
      projectsReassigned: 2,
      intentsCancelled: 1,
      environmentsDeleted: 4,
      revisionsDeleted: 9,
      runtimesDeleted: 3,
      imagesDeleted: 4,
    };
    const ddb = documentClient({
      marker: {
        pk: 'MIGRATION#managed-tool-catalog-reset',
        sk: 'META',
        status: 'COMPLETE',
        result,
      },
    });
    const g = graph();
    const store = { scanRegistry: vi.fn() };
    const processStore = { listActiveExecutions: vi.fn() };

    await expect(
      executeReset({
        g,
        actor: 'admin@example.com',
        store,
        process: processStore,
        documentClient: ddb,
        ecrClient: { send: vi.fn() },
        controlClient: { send: vi.fn() },
        runtimeClient: { send: vi.fn() },
        lambdaClient: { send: vi.fn() },
      }),
    ).resolves.toEqual(result);
    expect(store.scanRegistry).not.toHaveBeenCalled();
    expect(processStore.listActiveExecutions).not.toHaveBeenCalled();
  });

  it('starts destructive cleanup asynchronously after exact confirmation', async () => {
    let marker = null;
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'GetCommand') return { Item: marker };
        if (command.constructor.name === 'PutCommand') {
          marker = command.input.Item;
          return {};
        }
        if (command.constructor.name === 'UpdateCommand') return {};
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    const connectionFactory = vi.fn();
    const lambdaClient = { send: vi.fn().mockResolvedValue({ StatusCode: 202 }) };
    vi.stubEnv('AWS_LAMBDA_FUNCTION_NAME', 'managed-environment-reset');
    const handler = createResetHandler({
      connectionFactory,
      documentClient: ddb,
      lambdaClient,
    });

    const response = await handler({
      ...claims,
      httpMethod: 'POST',
      path: '/environment-reset',
      body: JSON.stringify({ confirmation: 'RESET MANAGED ENVIRONMENTS' }),
    });

    expect(response.statusCode).toBe(202);
    expect(connectionFactory).not.toHaveBeenCalled();
    expect(lambdaClient.send.mock.calls[0][0].input).toMatchObject({
      FunctionName: 'managed-environment-reset',
      InvocationType: 'Event',
    });
    expect(JSON.parse(Buffer.from(lambdaClient.send.mock.calls[0][0].input.Payload))).toEqual({
      action: 'execute',
      actor: 'admin@example.com',
      executionToken: expect.any(String),
    });
  });

  it('claims each asynchronous reset attempt only once', async () => {
    const marker = {
      status: 'IN_PROGRESS',
      executionToken: 'reset-token',
    };
    let claimed = false;
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name !== 'UpdateCommand') {
          throw new Error(`Unsupported command ${command.constructor.name}`);
        }
        if (claimed) {
          throw Object.assign(new Error('already claimed'), {
            name: 'ConditionalCheckFailedException',
          });
        }
        claimed = true;
        return {};
      }),
    };

    await expect(claimResetExecution(marker, 'reset-token', ddb)).resolves.toBe(true);
    await expect(claimResetExecution(marker, 'reset-token', ddb)).resolves.toBe(false);
    await expect(claimResetExecution(marker, 'older-token', ddb)).resolves.toBe(false);
  });

  it('recovers a reset marker left in progress beyond the Lambda timeout', async () => {
    let marker = {
      pk: 'MIGRATION#managed-tool-catalog-reset',
      sk: 'META',
      status: 'IN_PROGRESS',
      startedAt: '2026-08-13T00:00:00.000Z',
      updatedAt: '2026-08-13T00:00:00.000Z',
      startedBy: 'admin@example.com',
      attempt: 1,
    };
    const ddb = {
      send: vi.fn().mockImplementation(async (command) => {
        if (command.constructor.name === 'GetCommand') return { Item: marker };
        if (command.constructor.name === 'UpdateCommand') {
          marker = {
            ...marker,
            status: 'FAILED',
            failedAt: command.input.ExpressionAttributeValues[':failedAt'],
            updatedAt: command.input.ExpressionAttributeValues[':failedAt'],
            failure: command.input.ExpressionAttributeValues[':failure'],
          };
          return {};
        }
        throw new Error(`Unsupported command ${command.constructor.name}`);
      }),
    };
    await expect(recoverStaleMarker(marker, ddb)).resolves.toMatchObject({
      status: 'FAILED',
      failure: { message: 'The previous reset did not complete before its timeout' },
    });
    const update = ddb.send.mock.calls.find(
      ([command]) => command.constructor.name === 'UpdateCommand',
    )[0];
    expect(update.input).toMatchObject({
      ConditionExpression: '#status = :inProgress AND #timestamp = :expected',
      ExpressionAttributeNames: {
        '#status': 'status',
        '#timestamp': 'updatedAt',
      },
      ExpressionAttributeValues: {
        ':inProgress': 'IN_PROGRESS',
        ':expected': '2026-08-13T00:00:00.000Z',
        ':failed': 'FAILED',
      },
    });
  });
});
