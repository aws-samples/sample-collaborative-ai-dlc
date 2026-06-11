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

const nowSec = () => Math.floor(Date.now() / 1000);

// Registers the sender's connection row for the GetItem lookup.
const registerSender = (overrides = {}) => {
  ddbMock
    .on(GetItemCommand, {
      TableName: TABLE,
      Key: { connectionId: { S: SENDER } },
    })
    .resolves({
      Item: {
        connectionId: { S: SENDER },
        documentId: { S: REGISTERED_DOC },
        tokenExp: { N: String(nowSec() + 300) },
        ...overrides,
      },
    });
};

const allowlistedBody = (overrides = {}) => ({
  action: 'broadcastToDocument',
  documentId: REGISTERED_DOC,
  data: { action: 'question.answered', sprintId: 's-1', questionId: 'q-1' },
  ...overrides,
});

describe('ws-message handler (hardened send path)', () => {
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

  describe('allowlisted reload hints', () => {
    it('broadcasts question.answered to peers of the registered document, excluding sender', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: SENDER } },
          { connectionId: { S: 'peer-1' } },
          { connectionId: { S: 'peer-2' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
        TableName: TABLE,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: REGISTERED_DOC } },
      });
      const recipients = apiMock
        .commandCalls(PostToConnectionCommand)
        .map((c) => c.args[0].input.ConnectionId)
        .sort();
      expect(recipients).toEqual(['peer-1', 'peer-2']);
      const sent = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
      expect(sent).toEqual({ action: 'question.answered', sprintId: 's-1', questionId: 'q-1' });
    });

    it('broadcasts sprint.phaseChanged hints', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({ Items: [{ connectionId: { S: 'peer-1' } }] });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      await handler(
        makeEvent(allowlistedBody({ data: { action: 'sprint.phaseChanged', sprintId: 's-1' } })),
      );

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 1);
      const sent = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
      expect(sent).toEqual({ action: 'sprint.phaseChanged', sprintId: 's-1' });
    });

    it('accepts the event type via data.type as well as data.action', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({ Items: [{ connectionId: { S: 'peer-1' } }] });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      await handler(
        makeEvent(allowlistedBody({ data: { type: 'question.answered', sprintId: 's-1' } })),
      );

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 1);
    });
  });

  describe('registered-target binding (anti cross-document spoofing)', () => {
    it('ignores a spoofed body documentId and targets the registered document only', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({ Items: [{ connectionId: { S: 'peer-1' } }] });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent(allowlistedBody({ documentId: 'sprint:victim-sprint' })));

      // The query must use the sender's REGISTERED documentId, not the body value.
      expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
        TableName: TABLE,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: REGISTERED_DOC } },
      });
    });

    it('drops messages from connections without a registered row', async () => {
      ddbMock.on(GetItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('drops messages when the sender lookup fails', async () => {
      ddbMock.on(GetItemCommand).rejects(new Error('DDB timeout'));
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const handler = await loadHandler();
      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      consoleSpy.mockRestore();
    });
  });

  describe('client-event allowlist', () => {
    it.each([
      ['discussion.message', { action: 'discussion.message', message: { content: 'spoofed' } }],
      ['agent.chunk', { type: 'agent.chunk', text: 'spoofed stream' }],
      ['agent.completed', { type: 'agent.completed' }],
      ['artifact.updated', { action: 'artifact.updated' }],
      ['notification', { action: 'notification', userId: 'victim' }],
      ['awareness', { action: 'awareness', type: 'leave', userId: 'victim' }],
      ['unknown', { action: 'unknown' }],
      ['missing type', { foo: 'bar' }],
    ])('drops non-allowlisted client event: %s', async (_label, data) => {
      registerSender();

      const handler = await loadHandler();
      const res = await handler(makeEvent(allowlistedBody({ data })));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('drops a body without data entirely', async () => {
      registerSender();

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

  describe('token expiry', () => {
    it('rejects sends from a connection whose tokenExp has passed', async () => {
      registerSender({ tokenExp: { N: String(nowSec() - 10) } });

      const handler = await loadHandler();
      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('allows sends from legacy rows without tokenExp (pre-enforcement grace)', async () => {
      registerSender({ tokenExp: undefined });
      ddbMock.on(QueryCommand).resolves({ Items: [{ connectionId: { S: 'peer-1' } }] });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent(allowlistedBody()));

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 1);
    });

    it('excludes expired-token rows from the fan-out targets', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: 'peer-live' }, tokenExp: { N: String(nowSec() + 300) } },
          { connectionId: { S: 'peer-expired' }, tokenExp: { N: String(nowSec() - 10) } },
          { connectionId: { S: 'peer-legacy' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent(allowlistedBody()));

      const recipients = apiMock
        .commandCalls(PostToConnectionCommand)
        .map((c) => c.args[0].input.ConnectionId)
        .sort();
      expect(recipients).toEqual(['peer-legacy', 'peer-live']);
    });
  });

  describe('error handling', () => {
    it('swallows 410 Gone errors silently', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'stale' } }, { connectionId: { S: 'alive' } }],
      });
      const goneError = new Error('GoneException');
      goneError.statusCode = 410;
      apiMock
        .on(PostToConnectionCommand, { ConnectionId: 'stale' })
        .rejects(goneError)
        .on(PostToConnectionCommand, { ConnectionId: 'alive' })
        .resolves({});

      const handler = await loadHandler();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(consoleSpy).not.toHaveBeenCalledWith(
        expect.stringContaining('Send error'),
        expect.anything(),
        expect.anything(),
        expect.anything(),
      );
      consoleSpy.mockRestore();
    });

    it('logs non-410 errors but does not abort the broadcast', async () => {
      registerSender();
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'bad' } }, { connectionId: { S: 'good' } }],
      });
      const otherError = new Error('InternalError');
      otherError.statusCode = 500;
      apiMock
        .on(PostToConnectionCommand, { ConnectionId: 'bad' })
        .rejects(otherError)
        .on(PostToConnectionCommand, { ConnectionId: 'good' })
        .resolves({});

      const handler = await loadHandler();
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});

      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
      expect(consoleSpy).toHaveBeenCalledWith('Send error to', 'bad', ':', 'InternalError');
      consoleSpy.mockRestore();
    });

    it('handles DynamoDB query errors in broadcastToDocument gracefully', async () => {
      registerSender();
      ddbMock.on(QueryCommand).rejects(new Error('DDB timeout'));
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await handler(makeEvent(allowlistedBody()));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });
  });
});
