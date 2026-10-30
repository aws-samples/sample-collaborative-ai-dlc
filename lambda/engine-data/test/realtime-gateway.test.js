import { beforeEach, describe, expect, it } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createRealtimeGateway } from '../realtime-gateway.js';
import { REALTIME_EVENT } from '../realtime-schemas.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const KID = 'kid-1';
const TABLE = 'connections-test';
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const grantFor = (scope) =>
  issueGatewayGrant(scope, {
    keyId: KID,
    sign: async (m) => cryptoSign('sha256', m, privateKey),
    now: () => NOW,
    randomId: () => 'grant-1',
  });
const verifyGrant = (token) =>
  verifyGatewayGrant(token, {
    publicKeyFor: async (kid) => (kid === KID ? publicKey : null),
    now: () => NOW + 1000,
  });
const EXECUTION = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'i-1' };
const STAGE = { ...EXECUTION, mode: 'stage', stageId: 'build' };
const DISCUSSION = { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' };
const IDS = { executionId: 'i-1', intentId: 'i-1', projectId: 'p-1' };

const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const api = new ApiGatewayManagementApiClient({ endpoint: 'https://ws.example' });

let metas;
let stages;
let edits;
let composes;
let anchor;
let messages;
let graphCalls;

const gatewayWith = (overrides = {}) =>
  createRealtimeGateway({
    verifyGrant,
    createStore: () => ({
      getExecution: async (id) => metas[id] ?? null,
      getStage: async (executionId, id) => stages[`${executionId}/${id}`] ?? null,
      getQuorumEdit: async (executionId, id) => edits[`${executionId}/${id}`] ?? null,
      getCompose: async (executionId, id) => composes[`${executionId}/${id}`] ?? null,
    }),
    withGraph: async (fn) => {
      graphCalls += 1;
      return fn({});
    },
    readAnchor: async () => anchor,
    messageInIntent: async (_g, { intentId, discussionId, messageId }) =>
      messages.has(`${intentId}/${discussionId}/${messageId}`),
    ddb,
    api,
    connectionsTable: TABLE,
    ...overrides,
  });

const call = async (handler, payload, scope = EXECUTION) =>
  handler(
    JSON.parse(
      JSON.stringify({
        op: 'realtime.broadcastIntent',
        args: [{ payload }],
        grant: await grantFor(scope),
      }),
    ),
  );

const denial = (code) => ({
  error: expect.objectContaining({ name: 'EngineDataAccessDenied', code }),
});
const posted = () =>
  apiMock.commandCalls(PostToConnectionCommand).map((c) => c.args[0].input.ConnectionId);

beforeEach(() => {
  ddbMock.reset();
  apiMock.reset();
  metas = { 'i-1': { projectId: 'p-1', intentId: 'i-1' } };
  stages = { 'i-1/si-1': { executionId: 'i-1', stageInstanceId: 'si-1' } };
  edits = { 'i-1/e-1': { executionId: 'i-1' } };
  composes = { 'i-1/c-1': { composeId: 'c-1', executionId: 'i-1' } };
  anchor = { exists: true, projectIds: ['p-1'] };
  messages = new Set(['i-1/d-1/m-1']);
  graphCalls = 0;
  ddbMock.on(QueryCommand).resolves({ Items: [{ connectionId: 'c-a' }] });
  apiMock.on(PostToConnectionCommand).resolves({});
});

// One representative producer payload per action (shapes from run-stage,
// lanes, composer, discussion assist and the process bridge).
const SAMPLES = [
  { action: 'agent.workspace', ...IDS, state: 'INITIALIZED', repos: ['r'] },
  {
    action: 'agent.workspace',
    ...IDS,
    stageInstanceId: 'si-1',
    unitSlug: null,
    sectionIndex: null,
    summary: 'Restoring workspace...',
    state: 'RESTORED',
    repos: ['r'],
  },
  {
    action: 'agent.unit',
    ...IDS,
    unitSlug: 'u',
    sectionIndex: 0,
    state: 'LANE_READY',
    unitBranch: 'b',
  },
  { action: 'agent.units', ...IDS, unitCount: 2, state: 'PROMOTED' },
  {
    action: 'agent.stage',
    ...IDS,
    stageInstanceId: 'si-1',
    stageId: 'build',
    unitSlug: null,
    sectionIndex: null,
    phase: 'CONSTRUCTION',
    state: 'RUNNING',
  },
  {
    action: 'agent.note',
    ...IDS,
    stageInstanceId: 'si-1',
    noteType: 'v2.review.advisory',
    kind: 'review',
    note: 'n',
    summary: 's',
    sensorRunId: 'sr',
    eventId: 'ev',
  },
  { action: 'agent.steering', ...IDS, stageInstanceId: 'si-1', state: 'consumed', steerIds: ['s'] },
  {
    action: 'agent.question',
    ...IDS,
    stageInstanceId: 'si-1',
    humanTaskId: 'h',
    questions: [{ q: 1 }],
  },
  {
    action: 'agent.execution',
    ...IDS,
    status: 'RUNNING',
    currentPhase: 'P',
    currentStage: 'build',
  },
  {
    action: 'agent.metric',
    ...IDS,
    stageInstanceId: 'si-1',
    metricId: 'm',
    metrics: { credits: 1 },
  },
  {
    action: 'agent.output',
    ...IDS,
    stageInstanceId: 'si-1',
    seq: 3,
    kind: 'stdout',
    content: 'hi',
    timestamp: '2026-10-19T12:00:00.000Z',
    display: { kind: 'tool' },
  },
  {
    action: 'agent.output',
    ...IDS,
    stageInstanceId: 'qedit-e-1',
    seq: 1,
    kind: 'text',
    content: 'x',
  },
  { action: 'agent.pr', ...IDS, prs: [{ prUrl: 'u' }] },
  { action: 'agent.unit-pr', ...IDS, unitPrs: [{ prUrl: 'u' }] },
  { action: 'agent.derived', ...IDS, artifactCount: 1, sectionCount: 2, itemCount: 3 },
  { action: 'compose.updated', intentId: 'i-1', compose: { composeId: 'c-1', state: 'COMPLETED' } },
];

describe('realtime gateway — event DTO and grants', () => {
  it('broadcasts every observed engine action unchanged', async () => {
    const handler = gatewayWith();
    for (const payload of SAMPLES) {
      expect(REALTIME_EVENT.safeParse(payload).success).toBe(true);
      apiMock.resetHistory();
      await expect(call(handler, payload, STAGE)).resolves.toEqual({
        ok: true,
        result: { recipients: 1, delivered: 1, gone: 0, failed: 0 },
      });
      expect(apiMock.commandCalls(PostToConnectionCommand)[0].args[0].input.Data).toBe(
        JSON.stringify(payload),
      );
    }
  });

  it('rejects unknown actions, unknown fields and routing fields', async () => {
    const handler = gatewayWith();
    for (const payload of [
      { action: 'agent.secret', ...IDS },
      { action: 'agent.note', ...IDS, connectionId: 'c-x' },
      { action: 'agent.note', ...IDS, documentId: 'intent:i-2' },
      { action: 'agent.units', ...IDS, unitCount: -1 },
    ]) {
      await expect(call(handler, payload)).resolves.toEqual(denial('invalid_arguments'));
    }
    await expect(
      handler({ op: 'realtime.broadcastIntent', args: [{ payload: SAMPLES[3] }] }),
    ).resolves.toEqual(denial('missing_grant'));
    await expect(
      handler({ op: 'realtime.postToConnection', args: [{}], grant: await grantFor(EXECUTION) }),
    ).resolves.toEqual(denial('op_not_allowed'));
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fails an oversized event explicitly without trimming it', async () => {
    const handler = gatewayWith();
    const content = 'x'.repeat(32 * 1024);
    await expect(
      call(handler, { action: 'agent.output', ...IDS, stageInstanceId: 'si-1', content }),
    ).resolves.toEqual({
      error: expect.objectContaining({ name: 'EngineRealtimeError', code: 'event_too_large' }),
    });
    expect(posted()).toEqual([]);
  });

  it('denies embedded ownership ids that differ from the grant', async () => {
    const handler = gatewayWith();
    for (const override of [
      { projectId: 'p-2' },
      { intentId: 'i-2' },
      { executionId: 'i-2' },
      { sprintId: 'i-2' },
    ]) {
      await expect(call(handler, { ...SAMPLES[3], ...override })).resolves.toEqual(
        denial('scope_mismatch'),
      );
    }
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('resolves stages, Quorum edit panes and compose rows inside the execution', async () => {
    const handler = gatewayWith();
    const stageNote = { action: 'agent.note', ...IDS, stageInstanceId: 'si-9' };
    await expect(call(handler, stageNote)).resolves.toEqual(denial('scope_mismatch'));
    stages['i-1/si-9'] = { executionId: 'i-2' };
    await expect(call(handler, stageNote)).resolves.toEqual(denial('scope_mismatch'));
    await expect(
      call(handler, { action: 'agent.output', ...IDS, stageInstanceId: 'qedit-e-9' }),
    ).resolves.toEqual(denial('scope_mismatch'));
    await expect(
      call(handler, { action: 'agent.note', ...IDS, stageInstanceId: 'qedit-e-1' }),
    ).resolves.toEqual(denial('scope_mismatch'));
    for (const compose of [
      { composeId: 'c-9' },
      { composeId: 'c-1', executionId: 'i-2' },
      { composeId: 'c-1', pk: 'EXEC#i-2' },
      { state: 'COMPLETED' },
    ]) {
      await expect(
        call(handler, { action: 'compose.updated', intentId: 'i-1', compose }),
      ).resolves.toEqual(denial('scope_mismatch'));
    }
    await expect(
      call(handler, {
        action: 'compose.updated',
        intentId: 'i-1',
        compose: { pk: 'EXEC#i-1', sk: 'COMPOSE#c-1' },
      }),
    ).resolves.toMatchObject({ ok: true });
    expect(posted()).toEqual(['c-a']);
  });

  it('denies a contradictory META and requires META outside a draft compose', async () => {
    const handler = gatewayWith();
    metas['i-1'] = { projectId: 'p-2', intentId: 'i-1' };
    await expect(call(handler, SAMPLES[3])).resolves.toEqual(denial('scope_mismatch'));
    delete metas['i-1'];
    await expect(call(handler, SAMPLES[3], STAGE)).resolves.toEqual(denial('execution_not_found'));
    await expect(call(handler, SAMPLES.at(-1))).resolves.toMatchObject({ ok: true });
    expect(graphCalls).toBe(1);
    anchor = { exists: false, projectIds: [] };
    await expect(call(handler, SAMPLES.at(-1))).resolves.toEqual(denial('intent_not_found'));
    anchor = { exists: true, projectIds: ['p-2'] };
    await expect(call(handler, SAMPLES.at(-1))).resolves.toEqual(denial('scope_mismatch'));
  });
});

describe('realtime gateway — discussion grants', () => {
  const message = (overrides = {}) => ({
    action: 'discussion.message',
    intentId: 'i-1',
    sprintId: 'i-1',
    discussionId: 'd-1',
    message: { id: 'm-1', discussionId: 'd-1', sprintId: 'i-1', content: 'hello' },
    ...overrides,
  });

  it('may only send a discussion message resolved within the granted intent', async () => {
    const handler = gatewayWith();
    await expect(call(handler, message(), DISCUSSION)).resolves.toMatchObject({ ok: true });
    await expect(call(handler, SAMPLES[3], DISCUSSION)).resolves.toEqual(denial('op_not_allowed'));
    await expect(call(handler, message(), EXECUTION)).resolves.toEqual(denial('op_not_allowed'));
    await expect(
      call(handler, message({ discussionId: 'd-2', message: { id: 'm-1' } }), DISCUSSION),
    ).resolves.toEqual(denial('discussion_not_in_scope'));
    await expect(
      call(handler, message({ message: { id: 'm-1', discussionId: 'd-2' } }), DISCUSSION),
    ).resolves.toEqual(denial('discussion_not_in_scope'));
    await expect(
      call(handler, message({ message: { id: 'm-1', sprintId: 'i-2' } }), DISCUSSION),
    ).resolves.toEqual(denial('discussion_not_in_scope'));
    await expect(call(handler, message({ executionId: 'i-1' }), DISCUSSION)).resolves.toEqual(
      denial('scope_mismatch'),
    );
  });

  it('uses the intent anchor without META and denies a contradictory META', async () => {
    const handler = gatewayWith();
    delete metas['i-1'];
    await expect(call(handler, message(), DISCUSSION)).resolves.toMatchObject({ ok: true });
    anchor = { exists: true, projectIds: ['p-2'] };
    await expect(call(handler, message(), DISCUSSION)).resolves.toEqual(denial('scope_mismatch'));
    metas['i-1'] = { projectId: 'p-1', intentId: 'i-9' };
    anchor = { exists: true, projectIds: ['p-1'] };
    await expect(call(handler, message(), DISCUSSION)).resolves.toEqual(denial('scope_mismatch'));
  });
});

describe('realtime gateway — delivery', () => {
  it('queries the granted intent channel across every page and posts to all', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({
        Items: [{ connectionId: 'c-1' }, { connectionId: 'c-2' }],
        LastEvaluatedKey: { k: 1 },
      })
      .resolvesOnce({ Items: [{ connectionId: 'c-3' }], LastEvaluatedKey: { k: 2 } })
      .resolvesOnce({ Items: [{ connectionId: 'c-4' }] });
    apiMock
      .on(PostToConnectionCommand, { ConnectionId: 'c-2' })
      .rejects(Object.assign(new Error('gone'), { name: 'GoneException' }))
      .on(PostToConnectionCommand, { ConnectionId: 'c-3' })
      .rejects(Object.assign(new Error('slow down'), { name: 'ThrottlingException' }));
    const handler = gatewayWith();
    const response = await call(handler, SAMPLES[3]);
    expect(response).toEqual({
      ok: true,
      result: { recipients: 4, delivered: 2, gone: 1, failed: 1 },
    });
    expect(JSON.stringify(response)).not.toContain('c-1');
    expect(posted().toSorted()).toEqual(['c-1', 'c-2', 'c-3', 'c-4']);
    const queries = ddbMock.commandCalls(QueryCommand).map((c) => c.args[0].input);
    expect(queries.map((q) => q.ExclusiveStartKey)).toEqual([undefined, { k: 1 }, { k: 2 }]);
    expect(queries[0]).toMatchObject({
      TableName: TABLE,
      IndexName: 'DocumentIdIndex',
      ExpressionAttributeValues: { ':doc': 'intent:i-1' },
    });
    expect(ddbMock.commandCalls(ScanCommand)).toHaveLength(0);
  });

  it('reports zero recipients and fails closed when unconfigured', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [] });
    await expect(call(gatewayWith(), SAMPLES[3])).resolves.toEqual({
      ok: true,
      result: { recipients: 0, delivered: 0, gone: 0, failed: 0 },
    });
    for (const overrides of [{ api: null }, { connectionsTable: undefined }]) {
      await expect(call(gatewayWith(overrides), SAMPLES[3])).resolves.toEqual({
        error: expect.objectContaining({ code: 'realtime_misconfigured' }),
      });
    }
  });

  it('audits denials apart from delivery outcomes, without connection ids', async () => {
    const records = [];
    const handler = gatewayWith({ audit: (record) => records.push(record) });
    await call(handler, { ...SAMPLES[3], projectId: 'p-2' });
    await call(handler, SAMPLES[3]);
    expect(records.map(({ decision, reason, outcome }) => ({ decision, reason, outcome }))).toEqual(
      [
        { decision: 'deny', reason: 'scope_mismatch', outcome: undefined },
        { decision: 'allow', reason: undefined, outcome: 'ok' },
      ],
    );
    expect(JSON.stringify(records)).not.toContain('c-a');
  });
});
