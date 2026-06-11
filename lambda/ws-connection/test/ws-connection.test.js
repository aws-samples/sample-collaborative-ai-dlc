import { beforeEach, afterEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBClient,
  PutItemCommand,
  DeleteItemCommand,
  QueryCommand,
} from '@aws-sdk/client-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { SSMClient, GetParameterCommand } from '@aws-sdk/client-ssm';
import shared from '../../shared/realtime-token.js';

const { signRealtimeToken } = shared;

const ddbMock = mockClient(DynamoDBClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);
const ssmMock = mockClient(SSMClient);

const TABLE = 'test-connections';
const ENDPOINT = 'https://fake.execute-api.eu-west-1.amazonaws.com/prod';
const CONNECTION_ID = 'conn-self';
const SECRET = 'test-doc-secret';
const SPRINT_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const PROJECT_ID = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const SPRINT_DOC = `sprint:${SPRINT_ID}`;
const SUB = 'user-1';

const loadHandler = async () => {
  vi.resetModules();
  return (await import('../index.js')).handler;
};

const mintToken = (overrides = {}) =>
  signRealtimeToken(
    {
      sub: SUB,
      scopes: [`sprint:${SPRINT_ID}`, `project:${PROJECT_ID}`],
      ...overrides,
    },
    overrides.secret ?? SECRET,
  );

const makeEvent = (routeKey, overrides = {}) => ({
  requestContext: {
    connectionId: overrides.connectionId ?? CONNECTION_ID,
    routeKey,
    authorizer: overrides.authorizer,
  },
  queryStringParameters: overrides.queryStringParameters,
});

const connectEvent = (overrides = {}) => {
  const docToken = 'docToken' in overrides ? overrides.docToken : mintToken().token;
  return makeEvent('$connect', {
    authorizer: overrides.authorizer ?? { userId: SUB, userName: 'alice' },
    queryStringParameters: {
      documentId: SPRINT_DOC,
      ...(docToken === null ? {} : { docToken }),
      ...overrides.queryStringParameters,
    },
  });
};

describe('ws-connection handler', () => {
  beforeEach(() => {
    ddbMock.reset();
    apiMock.reset();
    ssmMock.reset();
    vi.stubEnv('CONNECTIONS_TABLE', TABLE);
    vi.stubEnv('WEBSOCKET_ENDPOINT', ENDPOINT);
    vi.stubEnv('REALTIME_DOC_SECRET', SECRET);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  describe('$connect (doc-token enforcement)', () => {
    it('writes a connection row with tokenExp for a valid token and returns 200', async () => {
      ddbMock.on(PutItemCommand).resolves({});
      const now = 1_700_000_000_000;
      vi.useFakeTimers();
      vi.setSystemTime(now);

      const { token, exp } = mintToken({ now });
      const handler = await loadHandler();
      const res = await handler(connectEvent({ docToken: token }));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandWith(PutItemCommand, {
        TableName: TABLE,
        Item: {
          connectionId: { S: CONNECTION_ID },
          userId: { S: SUB },
          userName: { S: 'alice' },
          documentId: { S: SPRINT_DOC },
          connectedAt: { N: String(now) },
          expiresAt: { N: String(Math.floor(now / 1000) + 3600) },
          tokenExp: { N: String(exp) },
        },
      });
    });

    it('accepts a project-scoped token for a bare projectId documentId', async () => {
      ddbMock.on(PutItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        connectEvent({ queryStringParameters: { documentId: PROJECT_ID } }),
      );

      expect(res).toEqual({ statusCode: 200 });
    });

    it('rejects a missing docToken with 403 and writes nothing', async () => {
      const handler = await loadHandler();
      const res = await handler(connectEvent({ docToken: null }));

      expect(res.statusCode).toBe(403);
      expect(ddbMock).toHaveReceivedCommandTimes(PutItemCommand, 0);
    });

    it('rejects an expired token with 403', async () => {
      const { token } = mintToken({ now: Date.now() - 11 * 60_000 });
      const handler = await loadHandler();
      const res = await handler(connectEvent({ docToken: token }));

      expect(res.statusCode).toBe(403);
    });

    it('rejects a token signed with the wrong secret with 403', async () => {
      const { token } = mintToken({ secret: 'attacker-secret' });
      const handler = await loadHandler();
      const res = await handler(connectEvent({ docToken: token }));

      expect(res.statusCode).toBe(403);
    });

    it('rejects a token whose scopes do not cover the requested document', async () => {
      const { token } = signRealtimeToken({ sub: SUB, scopes: ['sprint:other'] }, SECRET);
      const handler = await loadHandler();
      const res = await handler(connectEvent({ docToken: token }));

      expect(res.statusCode).toBe(403);
    });

    it('rejects a token bound to a different user (sub binding)', async () => {
      const { token } = signRealtimeToken(
        { sub: 'someone-else', scopes: [`sprint:${SPRINT_ID}`] },
        SECRET,
      );
      const handler = await loadHandler();
      const res = await handler(connectEvent({ docToken: token }));

      expect(res.statusCode).toBe(403);
    });

    it('rejects an unknown documentId format (deny-by-default)', async () => {
      const handler = await loadHandler();
      const res = await handler(connectEvent({ queryStringParameters: { documentId: 'doc-42' } }));

      expect(res.statusCode).toBe(403);
      expect(ddbMock).toHaveReceivedCommandTimes(PutItemCommand, 0);
    });

    it('rejects the legacy "default" documentId fallback', async () => {
      const handler = await loadHandler();
      const res = await handler(
        makeEvent('$connect', { authorizer: { userId: SUB, userName: 'alice' } }),
      );

      expect(res.statusCode).toBe(403);
    });

    it('allows and logs (without tokenExp) when DOC_TOKEN_ENFORCE=false', async () => {
      vi.stubEnv('DOC_TOKEN_ENFORCE', 'false');
      ddbMock.on(PutItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('$connect', {
          authorizer: { userId: SUB, userName: 'alice' },
          queryStringParameters: { documentId: 'doc-42' },
        }),
      );

      expect(res).toEqual({ statusCode: 200 });
      const item = ddbMock.commandCalls(PutItemCommand)[0].args[0].input.Item;
      expect(item.documentId).toEqual({ S: 'doc-42' });
      expect(item.tokenExp).toBeUndefined();
    });

    it('fetches the secret from SSM when REALTIME_DOC_SECRET is unset', async () => {
      vi.stubEnv('REALTIME_DOC_SECRET', '');
      vi.stubEnv('REALTIME_SECRET_PARAM', '/test/realtime-doc-secret');
      ssmMock
        .on(GetParameterCommand, { Name: '/test/realtime-doc-secret', WithDecryption: true })
        .resolves({ Parameter: { Value: SECRET } });
      ddbMock.on(PutItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(connectEvent());

      expect(res).toEqual({ statusCode: 200 });
      expect(ssmMock).toHaveReceivedCommandTimes(GetParameterCommand, 1);

      // Second call uses the cached secret — no extra SSM round-trip.
      await handler(connectEvent());
      expect(ssmMock).toHaveReceivedCommandTimes(GetParameterCommand, 1);
    });
  });

  describe('$disconnect', () => {
    it('queries peers, broadcasts leave to others, and deletes own row', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: CONNECTION_ID } },
          { connectionId: { S: 'peer-1' } },
          { connectionId: { S: 'peer-2' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(
        makeEvent('$disconnect', {
          authorizer: { userId: 'user-1', userName: 'alice' },
          queryStringParameters: { documentId: 'doc-42' },
        }),
      );

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

      const sent = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
      expect(sent).toEqual({ action: 'awareness', type: 'leave', userId: 'user-1' });

      expect(ddbMock).toHaveReceivedCommandWith(DeleteItemCommand, {
        TableName: TABLE,
        Key: { connectionId: { S: CONNECTION_ID } },
      });
    });

    it('excludes peers whose tokenExp has passed from the leave broadcast', async () => {
      const nowSec = Math.floor(Date.now() / 1000);
      ddbMock.on(QueryCommand).resolves({
        Items: [
          { connectionId: { S: 'peer-live' }, tokenExp: { N: String(nowSec + 300) } },
          { connectionId: { S: 'peer-expired' }, tokenExp: { N: String(nowSec - 10) } },
          { connectionId: { S: 'peer-legacy' } },
        ],
      });
      apiMock.on(PostToConnectionCommand).resolves({});
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent('$disconnect'));

      const recipients = apiMock
        .commandCalls(PostToConnectionCommand)
        .map((c) => c.args[0].input.ConnectionId)
        .sort();
      expect(recipients).toEqual(['peer-legacy', 'peer-live']);
    });

    it('uses documentId default "default" when query params are missing', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      await handler(
        makeEvent('$disconnect', {
          authorizer: { userId: 'user-1' },
        }),
      );

      expect(ddbMock).toHaveReceivedCommandWith(QueryCommand, {
        TableName: TABLE,
        IndexName: 'DocumentIdIndex',
        KeyConditionExpression: 'documentId = :docId',
        ExpressionAttributeValues: { ':docId': { S: 'default' } },
      });
    });

    it('broadcasts userId "anonymous" when authorizer is missing', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'peer-1' } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent('$disconnect'));

      const sent = JSON.parse(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data);
      expect(sent).toEqual({ action: 'awareness', type: 'leave', userId: 'anonymous' });
    });

    it('makes no post calls when query returns empty Items', async () => {
      ddbMock.on(QueryCommand).resolves({ Items: [] });
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('$disconnect'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteItemCommand, 1);
    });

    it('handles missing Items key from query response', async () => {
      ddbMock.on(QueryCommand).resolves({});
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('$disconnect'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteItemCommand, 1);
    });

    it('does not broadcast to self when sender is in the peer list', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: CONNECTION_ID } }],
      });
      apiMock.on(PostToConnectionCommand).resolves({});
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      await handler(makeEvent('$disconnect'));

      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteItemCommand, 1);
    });

    it('swallows query errors and still deletes the sender row', async () => {
      ddbMock.on(QueryCommand).rejects(new Error('DDB timeout'));
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('$disconnect'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteItemCommand, 1);
    });

    it('swallows post errors per peer and still deletes the sender row', async () => {
      ddbMock.on(QueryCommand).resolves({
        Items: [{ connectionId: { S: 'peer-1' } }, { connectionId: { S: 'peer-2' } }],
      });
      apiMock
        .on(PostToConnectionCommand, { ConnectionId: 'peer-1' })
        .rejects(new Error('Gone'))
        .on(PostToConnectionCommand, { ConnectionId: 'peer-2' })
        .resolves({});
      ddbMock.on(DeleteItemCommand).resolves({});

      const handler = await loadHandler();
      const res = await handler(makeEvent('$disconnect'));

      expect(res).toEqual({ statusCode: 200 });
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 2);
      expect(ddbMock).toHaveReceivedCommandWith(DeleteItemCommand, {
        TableName: TABLE,
        Key: { connectionId: { S: CONNECTION_ID } },
      });
    });
  });

  describe('other route keys', () => {
    it('returns 200 without touching DynamoDB or API Gateway for unknown routes', async () => {
      const handler = await loadHandler();
      const res = await handler(makeEvent('$default'));

      expect(res).toEqual({ statusCode: 200 });
      expect(ddbMock).toHaveReceivedCommandTimes(PutItemCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(QueryCommand, 0);
      expect(ddbMock).toHaveReceivedCommandTimes(DeleteItemCommand, 0);
      expect(apiMock).toHaveReceivedCommandTimes(PostToConnectionCommand, 0);
    });
  });
});
