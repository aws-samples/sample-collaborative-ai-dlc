import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient, QueryCommand, ScanCommand } from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';

const ddbMock = mockClient(DynamoDBClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);

const TABLE = 'test-connections';
const ENDPOINT = 'https://fake.execute-api.eu-west-1.amazonaws.com/prod';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const makeEvent = (body, connectionId = 'sender-conn') => ({
  requestContext: { connectionId },
  body: JSON.stringify(body),
});

describe('ws-message handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    apiMock.reset();
    vi.stubEnv('CONNECTIONS_TABLE', TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', ENDPOINT);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 200 when action does not match any route', async () => {
    const handler = await loadHandler();

    const res = await handler(makeEvent({ action: 'unknown' }));

    expect(res).toEqual({ statusCode: 200 });
    expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
    expect(ddbMock).toHaveReceivedCommandTimes(ScanCommand, 0);
  });

  it('handles empty event body gracefully', async () => {
    const handler = await loadHandler();

    const res = await handler({
      requestContext: { connectionId: 'conn-1' },
      body: null,
    });

    expect(res).toEqual({ statusCode: 200 });
  });

  describe('notification action', () => {
    it('queries UserIdIndex and broadcasts to all user connections', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: 'user-conn-1' } },
          { connectionId: { S: 'user-conn-2' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = { action: 'notification', data: { userId: 'user-123', text: 'hello' } };
      const res = await handler(makeEvent(body));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
        TableName: TABLE,
        IndexName: 'UserIdIndex',
        KeyConditionExpression: 'userId = :uid',
        ExpressionAttributeValues: { ':uid': { S: 'user-123' } },
      });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
    });

    it('does nothing when data.userId is missing', async () => {
      const handler = await loadHandler();

      const res = await handler(makeEvent({ action: 'notification', data: {} }));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
    });

    it('does nothing when data is missing entirely', async () => {
      const handler = await loadHandler();

      const res = await handler(makeEvent({ action: 'notification' }));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
    });

    it('does NOT exclude the sender — broadcasts to all user connections including sender', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: 'sender-conn' } },
          { connectionId: { S: 'other-conn' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = { action: 'notification', data: { userId: 'user-1', text: 'ping' } };
      await handler(makeEvent(body, 'sender-conn'));

      const recipients = apiMock
        .commandCalls(PostToConnectionCommand)
        .map((c) => c.args[0].input.ConnectionId)
        .sort();
      expect(recipients).toEqual(['other-conn', 'sender-conn']);
    });

    it('sends the full message body as payload', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'user-conn' } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = { action: 'notification', data: { userId: 'u1', text: 'hello' } };
      await handler(makeEvent(body));

      const sent = JSON.parse(
        apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data,
      );
      expect(sent).toEqual(body);
    });

    it('makes no post calls when user has zero connections', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const handler = await loadHandler();
      await handler(makeEvent({ action: 'notification', data: { userId: 'u1' } }));

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('handles missing Items key from DynamoDB response', async () => {
      ddbMock.on(QueryCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent({ action: 'notification', data: { userId: 'u1' } }));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });
  });

  describe('broadcast action', () => {
    it('scans all connections and broadcasts to everyone except sender', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { connectionId: { S: 'sender-conn' } },
          { connectionId: { S: 'other-conn-1' } },
          { connectionId: { S: 'other-conn-2' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = { action: 'broadcast', data: { text: 'hi everyone' } };
      const res = await handler(makeEvent(body, 'sender-conn'));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandWith(ScanCommand, { TableName: TABLE });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
      const recipients = apiMock
        .commandCalls(PostToConnectionCommand)
        .map((c) => c.args[0].input.ConnectionId)
        .sort();
      expect(recipients).toEqual(['other-conn-1', 'other-conn-2']);
    });

    it('sends the full body as the message payload', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [{ connectionId: { S: 'peer' } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = { action: 'broadcast', data: { text: 'payload' } };
      await handler(makeEvent(body, 'sender'));

      const sent = JSON.parse(
        apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data,
      );
      expect(sent).toEqual(body);
    });

    it('sends zero messages when sender is the only connection', async () => {
      ddbMock.on(ScanCommand).resolves({
        Items: [{ connectionId: { S: 'sender-conn' } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent({ action: 'broadcast' }, 'sender-conn'));

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('makes no post calls when scan returns empty Items', async () => {
      ddbMock.on(ScanCommand).resolves({ Items: [] });

      const handler = await loadHandler();
      await handler(makeEvent({ action: 'broadcast' }, 'sender'));

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('handles missing Items key from scan response', async () => {
      ddbMock.on(ScanCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent({ action: 'broadcast' }, 'sender'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });
  });

  describe('broadcastToDocument action', () => {
    it('queries DocumentIdIndex and broadcasts to peers excluding sender', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: 'sender-conn' } },
          { connectionId: { S: 'peer-1' } },
          { connectionId: { S: 'peer-2' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = {
        action: 'broadcastToDocument',
        documentId: 'doc-42',
        data: { type: 'cursor', x: 10 },
      };
      const res = await handler(makeEvent(body, 'sender-conn'));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
        TableName: TABLE,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: 'doc-42' } },
      });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
      const recipients = apiMock
        .commandCalls(PostToConnectionCommand)
        .map((c) => c.args[0].input.ConnectionId)
        .sort();
      expect(recipients).toEqual(['peer-1', 'peer-2']);
    });

    it('forwards body.data as the message when present', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'peer' } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = {
        action: 'broadcastToDocument',
        documentId: 'doc-1',
        data: { type: 'edit', content: 'updated' },
      };
      await handler(makeEvent(body, 'sender'));

      const sent = JSON.parse(
        apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data,
      );
      expect(sent).toEqual({ type: 'edit', content: 'updated' });
    });

    it('falls back to body when data is not present', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'peer' } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const body = { action: 'broadcastToDocument', documentId: 'doc-1' };
      await handler(makeEvent(body, 'sender'));

      const sent = JSON.parse(
        apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data,
      );
      expect(sent).toEqual(body);
    });

    it('does nothing when documentId is missing', async () => {
      const handler = await loadHandler();

      const res = await handler(makeEvent({ action: 'broadcastToDocument' }));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
    });

    it('makes no post calls when document has zero connections', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });

      const handler = await loadHandler();
      await handler(makeEvent({
        action: 'broadcastToDocument',
        documentId: 'doc-1',
        data: { type: 'sync' },
      }, 'sender'));

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });

    it('handles missing Items key from query response', async () => {
      ddbMock.on(QueryCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent({
        action: 'broadcastToDocument',
        documentId: 'doc-1',
      }, 'sender'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });
  });

  describe('error handling', () => {
    it('swallows 410 Gone errors silently', async () => {
      ddbMock.on(ScanCommand).resolves({
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

      const res = await handler(makeEvent({ action: 'broadcast' }, 'other'));

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
      ddbMock.on(ScanCommand).resolves({
        Items: [
          { connectionId: { S: 'bad' } },
          { connectionId: { S: 'good' } },
        ],
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

      const res = await handler(makeEvent({ action: 'broadcast' }, 'other'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
      expect(consoleSpy).toHaveBeenCalledWith(
        'Send error to', 'bad', ':', 'InternalError',
      );
      consoleSpy.mockRestore();
    });

    it('handles DynamoDB query errors in broadcastToDocument gracefully', async () => {
      ddbMock.on(QueryCommand).rejects(new Error('DDB timeout'));
      apiMock.on(PostToConnectionCommand).resolves({});

      const handler = await loadHandler();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await handler(makeEvent({
        action: 'broadcastToDocument',
        documentId: 'doc-1',
        data: { type: 'sync' },
      }, 'sender'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('handles DynamoDB query errors in broadcastToUser gracefully', async () => {
      ddbMock.on(QueryCommand).rejects(new Error('ProvisionedThroughputExceeded'));

      const handler = await loadHandler();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await handler(makeEvent({
        action: 'notification',
        data: { userId: 'user-1' },
      }));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('handles DynamoDB scan errors in broadcastToAll gracefully', async () => {
      ddbMock.on(ScanCommand).rejects(new Error('ServiceUnavailable'));

      const handler = await loadHandler();
      const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const res = await handler(makeEvent({ action: 'broadcast' }, 'sender'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('throws on malformed JSON in event.body', async () => {
      const handler = await loadHandler();

      await expect(handler({
        requestContext: { connectionId: 'conn-1' },
        body: 'not valid json{',
      })).rejects.toThrow();
    });
  });
});
