import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { createRequire } from 'node:module';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const require = createRequire(import.meta.url);

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);

const TABLE = 'test-connections';
const ENDPOINT = 'https://fake.execute-api.us-east-1.amazonaws.com/test';

const loadHandler = () => {
  vi.resetModules();
  delete require.cache[require.resolve('../notify')];
  return require('../notify').handler;
};

const sentPayloads = () =>
  apiMock
    .commandCalls(PostToConnectionCommand)
    .map((c) => JSON.parse(c.args[0].input.Data));

describe('notify handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    apiMock.reset();
    vi.stubEnv('CONNECTIONS_TABLE', TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', ENDPOINT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('broadcasts to all connections for the projectId channel', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ connectionId: 'c1' }, { connectionId: 'c2' }],
    });
    apiMock.on(PostToConnectionCommand).resolves({});

    const handler = loadHandler();
    const res = await handler({
      'detail-type': 'agent.started',
      detail: { projectId: 'proj-1', agentId: 'a1' },
    });

    expect(res).toEqual({ statusCode: 200 });
    expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 1);
    expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
      TableName: TABLE,
      IndexName: 'DocumentIdIndex',
      KeyConditionExpression: 'documentId = :docId',
      ExpressionAttributeValues: { ':docId': 'proj-1' },
    });
    expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
    expect(apiMock).toHaveReceivedCommandWith(PostToConnectionCommand, {
      ConnectionId: 'c1',
    });
    expect(apiMock).toHaveReceivedCommandWith(PostToConnectionCommand, {
      ConnectionId: 'c2',
    });
  });

  it('also broadcasts to the sprint channel when sprintId is present', async () => {
    ddbMock
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':docId': 'proj-1' },
      })
      .resolves({ Items: [{ connectionId: 'proj-conn' }] })
      .on(QueryCommand, {
        ExpressionAttributeValues: { ':docId': 'sprint:s-1' },
      })
      .resolves({ Items: [{ connectionId: 'sprint-conn' }] });
    apiMock.on(PostToConnectionCommand).resolves({});

    const handler = loadHandler();
    const res = await handler({
      'detail-type': 'sprint.phaseChanged',
      detail: { projectId: 'proj-1', sprintId: 's-1', phase: 'review' },
    });

    expect(res).toEqual({ statusCode: 200 });
    expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 2);
    expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
    const conns = apiMock
      .commandCalls(PostToConnectionCommand)
      .map((c) => c.args[0].input.ConnectionId)
      .sort();
    expect(conns).toEqual(['proj-conn', 'sprint-conn']);
  });

  it('issues a single query when only projectId is present', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const handler = loadHandler();
    await handler({
      'detail-type': 'artifact.created',
      detail: { projectId: 'proj-1' },
    });

    expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 1);
  });

  it('does nothing when neither projectId nor sprintId is present', async () => {
    const handler = loadHandler();
    const res = await handler({
      'detail-type': 'agent.error',
      detail: { message: 'unscoped event' },
    });

    expect(res).toEqual({ statusCode: 200 });
    expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
    expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
  });

  it('makes no post calls when the connections query returns no items', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });

    const handler = loadHandler();
    const res = await handler({
      'detail-type': 'artifact.created',
      detail: { projectId: 'proj-1' },
    });

    expect(res).toEqual({ statusCode: 200 });
    expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
  });

  it('swallows per-connection post failures and keeps broadcasting', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [
        { connectionId: 'c1' },
        { connectionId: 'c2' },
        { connectionId: 'c3' },
      ],
    });
    apiMock
      .on(PostToConnectionCommand)
      .resolves({})
      .on(PostToConnectionCommand, { ConnectionId: 'c2' })
      .rejects(new Error('GoneException'));

    const handler = loadHandler();
    const res = await handler({
      'detail-type': 'agent.completed',
      detail: { projectId: 'proj-1' },
    });

    expect(res).toEqual({ statusCode: 200 });
    expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 3);
  });

  it('sends a message with action=detail-type and the detail payload', async () => {
    ddbMock.on(QueryCommand).resolves({
      Items: [{ connectionId: 'c1' }],
    });
    apiMock.on(PostToConnectionCommand).resolves({});

    const handler = loadHandler();
    await handler({
      'detail-type': 'agent.question',
      detail: { projectId: 'proj-1', questionId: 'q1', text: 'why?' },
    });

    expect(sentPayloads()).toEqual([
      {
        action: 'agent.question',
        projectId: 'proj-1',
        questionId: 'q1',
        text: 'why?',
      },
    ]);
  });
});
