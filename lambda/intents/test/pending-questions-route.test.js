import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
// The real HTTP handler and process store; only the graph and the AWS
// transport are stubbed.
vi.mock('@aws-sdk/credential-providers', () => ({
  fromNodeProviderChain: () => async () => ({ accessKeyId: 'test', secretAccessKey: 'test' }),
}));
vi.mock('gremlin', async (original) => {
  const actual = await original();
  const g = { V: () => g, has: () => g, hasNext: async () => false, withRemote: () => g };
  return {
    default: {
      ...actual.default,
      driver: {
        ...actual.default.driver,
        DriverRemoteConnection: class {
          async close() {}
        },
      },
      process: { ...actual.default.process, traversal: () => g },
    },
  };
});
const graph = vi.hoisted(() => ({ listMemberships: vi.fn(), fetchMembershipRole: vi.fn() }));
vi.mock('../../shared/trackers.js', async (original) => ({
  ...(await original()),
  listMemberships: graph.listMemberships,
  fetchMembershipRole: graph.fetchMembershipRole,
}));
vi.mock('../../shared/ws-fanout.js', () => ({ broadcastToIntentChannel: async () => {} }));
import { handler } from '../index.js';
const ddb = mockClient(DynamoDBDocumentClient);
const request = ({ sub = 'u1', query = null } = {}) =>
  handler({
    httpMethod: 'GET',
    path: '/users/me/pending-questions',
    pathParameters: null,
    queryStringParameters: query,
    requestContext: { authorizer: { claims: sub ? { sub } : {} } },
  });
const body = (res) => JSON.parse(res.body);
describe('GET /users/me/pending-questions', () => {
  beforeEach(() => {
    ddb.reset();
    graph.listMemberships.mockReset();
    graph.fetchMembershipRole.mockReset();
    vi.stubEnv('NEPTUNE_ENDPOINT', 'localhost');
    vi.stubEnv('V2_PROCESS_TABLE', 'test-process');
    graph.listMemberships.mockResolvedValue([
      { projectId: 'p1', projectName: 'Payments', kind: 'v2', role: 'member' },
    ]);
    ddb.on(QueryCommand).callsFake(async (input) => {
      if (input.IndexName === 'GSI1')
        return input.ExpressionAttributeValues[':sk'] === 'STATUS#WAITING#'
          ? {
              Items: [
                {
                  executionId: 'i1',
                  projectId: 'p1',
                  status: 'WAITING',
                  orchestratorRunId: 'run1',
                  title: 'Refund API',
                },
              ],
            }
          : { Items: [] };
      return {
        Items: [
          {
            humanTaskId: 'h1',
            kind: 'question',
            status: 'pending',
            orchestratorRunId: 'run1',
            stageInstanceId: null,
            questions: JSON.stringify([{ text: 'Which rounding?' }]),
            createdAt: '2026-01-01T00:00:00.000Z',
          },
        ],
      };
    });
    ddb.on(GetCommand).resolves({});
  });
  afterEach(() => vi.unstubAllEnvs());

  it('401s without an identity', async () => {
    const res = await request({ sub: null });
    expect(res.statusCode).toBe(401);
    expect(graph.listMemberships).not.toHaveBeenCalled();
  });
  it('returns the caller’s pending questions, uncached, without a project authorize', async () => {
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(res.headers['Cache-Control']).toBe('private, no-store');
    expect(body(res)).toMatchObject({
      items: [
        {
          id: 'i1:h1',
          projectName: 'Payments',
          intentTitle: 'Refund API',
          summary: 'Which rounding?',
          eligibility: { basis: 'space-member', assignment: 'open' },
          target: { view: 'gate', projectId: 'p1', intentId: 'i1', humanTaskId: 'h1' },
        },
      ],
      nextCursor: null,
      unavailable: [],
    });
    expect(body(res)).not.toHaveProperty('stats');
    expect(graph.listMemberships).toHaveBeenCalledWith(expect.anything(), 'u1');
    expect(graph.fetchMembershipRole).not.toHaveBeenCalled();
  });
  it('403s a space filter the caller is not a member of, without reading it', async () => {
    const res = await request({ query: { projectId: 'p9' } });
    expect(res.statusCode).toBe(403);
    expect(body(res)).toEqual({ error: 'Not a project member', code: 'NOT_A_MEMBER' });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it('503s when memberships cannot be read', async () => {
    graph.listMemberships.mockRejectedValue(new Error('gremlin down'));
    const res = await request();
    expect(res.statusCode).toBe(503);
    expect(body(res)).toEqual({
      error: 'Could not load your spaces',
      code: 'MEMBERSHIP_UNAVAILABLE',
      retryable: true,
    });
    expect(ddb.commandCalls(QueryCommand)).toHaveLength(0);
  });
  it.each([
    [{ limit: '0' }, 'INVALID_LIMIT'],
    [{ cursor: '!!' }, 'INVALID_CURSOR'],
    [{ kind: 'nope' }, 'INVALID_KIND'],
  ])('400s invalid parameters %j before any read', async (query, code) => {
    const res = await request({ query });
    expect(res.statusCode).toBe(400);
    expect(body(res).code).toBe(code);
    expect(graph.listMemberships).not.toHaveBeenCalled();
  });
  it('reports a failed space read as unavailable, not as nothing to do', async () => {
    ddb.on(QueryCommand).rejects(new Error('throttled'));
    const res = await request();
    expect(res.statusCode).toBe(200);
    expect(body(res)).toMatchObject({
      items: [],
      unavailable: [{ projectId: 'p1', projectName: 'Payments', reason: 'READ_FAILED' }],
    });
  });
});
