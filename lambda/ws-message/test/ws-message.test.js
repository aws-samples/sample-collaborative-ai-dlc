import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  QueryCommand,
  ScanCommand,
  GetItemCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const ddbMock = mockClient(DynamoDBClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);

const TABLE = 'test-connections';
const ENDPOINT = 'https://fake.execute-api.eu-west-1.amazonaws.com/prod';
const SENDER = 'sender-conn';
const REGISTERED_DOC = 'sprint:0f8fad5b-d9cb-469f-a165-70867728950e';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const makeEvent = (body, connectionId = SENDER) => ({
  requestContext: { connectionId },
  body: JSON.stringify(body),
});

// -----------------------------------------------------------------------------
// The client-event allowlist is EMPTY: all realtime events are server-origin.
// question.answered and sprint.phaseChanged are emitted server-side
// (lambda/shared/ws-fanout.js from the questions/agents/sprints lambdas), and
// connected clients cannot inject ANY event through broadcastToDocument.
// -----------------------------------------------------------------------------
describe('ws-message handler (fully server-origin)', () => {
  beforeEach(() => {
    ddbMock.reset();
    apiMock.reset();
    vi.stubEnv('CONNECTIONS_TABLE', TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', ENDPOINT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('handles empty event body gracefully', async () => {
    const handler = await loadHandler();
    const res = await handler({ requestContext: { connectionId: 'conn-1' }, body: null });
    expect(res).toEqual({ statusCode: 200 });
  });

  it('throws on malformed JSON in event.body', async () => {
    const handler = await loadHandler();
    await expect(
      handler({ requestContext: { connectionId: 'conn-1' }, body: 'not valid json{' }),
    ).rejects.toThrow();
  });

  describe('client broadcastToDocument of ANY event type is rejected', () => {
    it.each([
      // The two formerly-allowlisted reload hints — now server-origin only.
      ['question.answered', { action: 'question.answered', sprintId: 's-1', questionId: 'q-1' }],
      ['sprint.phaseChanged', { action: 'sprint.phaseChanged', sprintId: 's-1' }],
      // Everything that was always forbidden.
      ['discussion.message', { action: 'discussion.message', message: { content: 'spoofed' } }],
      ['agent.chunk', { type: 'agent.chunk', text: 'spoofed stream' }],
      ['agent.completed', { type: 'agent.completed' }],
      ['artifact.updated', { action: 'artifact.updated' }],
      ['notification', { action: 'notification', userId: 'victim' }],
      ['awareness', { action: 'awareness', type: 'leave', userId: 'victim' }],
      ['unknown', { action: 'unknown' }],
      ['missing type', { foo: 'bar' }],
    ])('drops %s without touching DynamoDB or API Gateway', async (_label, data) => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent({ action: 'broadcastToDocument', documentId: REGISTERED_DOC, data }),
      );

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(GetItemCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('drops a body without data entirely', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent({ action: 'broadcastToDocument', documentId: REGISTERED_DOC }),
      );

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });
  });

  describe('removed legacy actions', () => {
    it('rejects the scan-all broadcast action without touching DynamoDB', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent({ action: 'broadcast', data: { text: 'hi' } }));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(ScanCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('rejects the client notification action without touching DynamoDB', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent({ action: 'notification', data: { userId: 'victim', text: 'spoofed' } }),
      );

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('rejects unknown actions', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent({ action: 'unknown' }));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
    });
  });
});
