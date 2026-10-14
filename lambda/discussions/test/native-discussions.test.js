// Native execution discussions and advisory Quorum (task-2).
//
// Real gremlin-server graph (per-file partition) and real membership edges.
// Protected native records are an in-memory DynamoDB fake; publications are
// written with the real publication module onto an in-memory versioned S3.
import { beforeAll, beforeEach, afterAll, afterEach, describe, it, expect, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  UpdateCommand,
  DeleteCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand, PutObjectCommand } from '@aws-sdk/client-s3';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { createNativePublications } from '../../shared/native-publication.js';
import { nativeRuntimeBindingKey } from '../../shared/native-runtime-binding.js';
import { nativeCollaborationDigest, nativeIntentChannel } from '../../shared/native-realtime.js';
import { verifyAgentCredentialGrant } from '../../shared/agent-credential-grants.js';

const NOW = new Date('2026-10-01T12:00:00.000Z');
const PARTITION = `t-${randomUUID()}`;
const LOCKS_TABLE = 'discussion-locks-test';
const NATIVE_TABLE = 'native-runs-test';
const CONNECTIONS_TABLE = 'connections-test';
const PROCESS_TABLE = 'v2-process-test';
const BUCKET = 'native-results-test';
const ACCOUNT = '123456789012';
const CORE_RUNTIME = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/core';
const GRANT_SECRET = 'g'.repeat(48);
const MEMBER = 'member-user';
const SECOND = 'second-member';
const OUTSIDER = 'outsider-user';
const packageId = `sha256:${'a'.repeat(64)}`;

// Neptune graph IDs are strings; the test TinkerGraph uses Long IDs, which the
// real snapshot (unit-tested in shared/test/workflow-source-membership.test.js)
// rejects. Read the same live membership edge and identities, as strings.
vi.mock('../../shared/workflow-source-membership.js', async () => {
  const { default: gremlinLib } = await import('gremlin');
  const { t: T, statics: __ } = gremlinLib.process;
  return {
    fetchWorkflowSourceMembership: async (graph, projectId, userId) => {
      const rows = await graph
        .V()
        .has('Project', 'id', projectId)
        .project('projectIdentity', 'memberships')
        .by(T.id)
        .by(
          __.outE('HAS_MEMBER')
            .where(__.inV().has('User', 'id', userId))
            .project('membershipId', 'role')
            .by(T.id)
            .by('role')
            .fold(),
        )
        .toList();
      const memberships = rows[0]?.get('memberships') ?? [];
      if (memberships.length !== 1) return null;
      return {
        role: memberships[0].get('role'),
        membershipId: String(memberships[0].get('membershipId')),
        projectIdentity: String(rows[0].get('projectIdentity')),
      };
    },
  };
});

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);
const apiMock = mockClient(ApiGatewayManagementApiClient);
const agentcoreMock = mockClient(BedrockAgentCoreClient);
const lambdaMock = mockClient(LambdaClient);

const locks = new Map();
const nativeRows = new Map();
const objects = new Map();
let connectionQueries = [];

const condFail = () =>
  Object.assign(new Error('conditional'), { name: 'ConditionalCheckFailedException' });
const installFakes = () => {
  ddbMock
    .on(PutCommand)
    .callsFake(async ({ TableName, Item, ConditionExpression, ExpressionAttributeValues }) => {
      if (TableName !== LOCKS_TABLE) return {};
      const existing = locks.get(Item.lockId);
      if (ConditionExpression && existing) {
        const now = ExpressionAttributeValues?.[':now'];
        const ok = ConditionExpression.includes('guardState = :pending')
          ? existing.guardState === 'pending' && existing.expiresAt < now
          : existing.expiresAt < now;
        if (!ok) throw condFail();
      }
      locks.set(Item.lockId, { ...Item });
      return {};
    });
  ddbMock.on(GetCommand).callsFake(async ({ TableName, Key }) => {
    if (TableName === NATIVE_TABLE) {
      const item = nativeRows.get(`${Key.pk}|${Key.sk}`);
      return item ? { Item: structuredClone(item) } : {};
    }
    if (TableName === LOCKS_TABLE) {
      const item = locks.get(Key.lockId);
      return item ? { Item: { ...item } } : {};
    }
    if (TableName === PROCESS_TABLE)
      throw new Error('native threads must never read platform META');
    return {};
  });
  ddbMock.on(UpdateCommand).callsFake(async ({ TableName, Key, ExpressionAttributeValues }) => {
    if (TableName !== LOCKS_TABLE) return {};
    const item = locks.get(Key.lockId);
    if (!item || item.ownerToken !== ExpressionAttributeValues[':token']) throw condFail();
    item.guardState = ExpressionAttributeValues[':complete'];
    item.expiresAt = ExpressionAttributeValues[':exp'];
    return {};
  });
  ddbMock.on(DeleteCommand).callsFake(async ({ TableName, Key }) => {
    if (TableName === LOCKS_TABLE) locks.delete(Key.lockId);
    return {};
  });
  ddbMock.on(QueryCommand).callsFake(async (input) => {
    if (input.TableName === CONNECTIONS_TABLE) {
      connectionQueries.push(
        input.ExpressionAttributeValues[':docId'] ?? input.ExpressionAttributeValues[':uid'],
      );
      return { Items: [{ connectionId: 'c1', tokenExp: Date.now() / 1000 + 600 }] };
    }
    return { Items: [] };
  });
  s3Mock.on(PutObjectCommand).callsFake(async ({ Key, Body }) => {
    const version = `v-${objects.size + 1}`;
    objects.set(`${Key}:${version}`, Buffer.from(Body));
    return { VersionId: version };
  });
  s3Mock.on(GetObjectCommand).callsFake(async ({ Key, VersionId, Bucket, ExpectedBucketOwner }) => {
    expect(Bucket).toBe(BUCKET);
    expect(ExpectedBucketOwner).toBe(ACCOUNT);
    const bytes = objects.get(`${Key}:${VersionId}`);
    if (!bytes) throw new Error('missing version');
    return { VersionId, ContentLength: bytes.length, Body: Readable.from([bytes]) };
  });
};

let handler;
let close;
let conn;
let g;
let resetRevisions;
let createAssistResultHandler;

beforeAll(async () => {
  vi.stubEnv('GREMLIN_PARTITION', PARTITION);
  vi.stubEnv('AWS_PROFILE', undefined);
  ({ handler, close } = await import('../index.js'));
  ({ createAssistResultHandler } = await import('../assist-result.js'));
  ({ resetNativeArtifactRevisionsForTest: resetRevisions } = await import('../services.js'));
  conn = new gremlin.driver.DriverRemoteConnection(
    `ws://${process.env.NEPTUNE_ENDPOINT}:${process.env.GREMLIN_PORT}/gremlin`,
  );
  g = gremlin.process.AnonymousTraversalSource.traversal()
    .withRemote(conn)
    .withStrategies(
      new PartitionStrategy({
        partitionKey: '_partition',
        writePartition: PARTITION,
        readPartitions: [PARTITION],
      }),
    );
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await close?.();
  await conn?.close();
});

beforeEach(async () => {
  await g.V().drop().next();
  for (const mock of [ddbMock, s3Mock, apiMock, agentcoreMock, lambdaMock]) mock.reset();
  locks.clear();
  nativeRows.clear();
  objects.clear();
  connectionQueries = [];
  installFakes();
  resetRevisions();
  apiMock.on(PostToConnectionCommand).resolves({});
  agentcoreMock.on(InvokeAgentRuntimeCommand).resolves({
    response: { transformToString: async () => JSON.stringify({ ok: true, accepted: true }) },
  });
  lambdaMock.on(InvokeCommand).callsFake(() => ({
    StatusCode: 200,
    Payload: Buffer.from(
      JSON.stringify({ ok: true, bindings: { kiro: { provider: 'kiro', source: 'platform' } } }),
    ),
  }));
  for (const [key, value] of Object.entries({
    LOCKS_TABLE,
    READ_STATE_TABLE: '',
    V2_PROCESS_TABLE: PROCESS_TABLE,
    NATIVE_RUNTIME_BINDINGS_TABLE: NATIVE_TABLE,
    NATIVE_EXECUTION_PUBLICATION_BUCKET: BUCKET,
    NATIVE_RUNTIME_ACCOUNT_ID: ACCOUNT,
    CONNECTIONS_TABLE,
    WEBSOCKET_ENDPOINT: 'https://ws.example.invalid',
    AGENTCORE_RUNTIME_ARN: CORE_RUNTIME,
    AGENT_CREDENTIAL_METADATA_FUNCTION: 'credential-metadata-test',
    AGENT_CREDENTIAL_GRANT_SECRET: GRANT_SECRET,
    REALTIME_DOC_SECRET: 'doc-secret',
  }))
    vi.stubEnv(key, value);
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(NOW);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

// ─── Seeds ───

const seedProject = async (projectId, members) => {
  await g.addV('Project').property('id', projectId).next();
  for (const sub of members) {
    const exists = await g.V().has('User', 'id', sub).hasNext();
    if (!exists) await g.addV('User').property('id', sub).next();
    await g
      .V()
      .has('Project', 'id', projectId)
      .as('p')
      .V()
      .has('User', 'id', sub)
      .as('u')
      .addE('HAS_MEMBER')
      .property('role', 'member')
      .from_('p')
      .to('u')
      .next();
  }
  return String((await g.V().has('Project', 'id', projectId).id().next()).value);
};

const s3 = new S3Client({});
const publications = () =>
  createNativePublications({
    s3,
    bucket: BUCKET,
    accountId: ACCOUNT,
    now: () => NOW.toISOString(),
  });

// One native execution with its protected RUNTIME/EXECUTION rows and two
// sequential publications; `docs/plan.md` changes between them.
const seedNativeExecution = async ({ projectId, executionId = randomUUID(), projectIdentity }) => {
  const scope = { projectId, executionId };
  const key = nativeRuntimeBindingKey(scope);
  const attemptId = randomUUID();
  const write = (sequence, plan) =>
    publications().write({
      identity: { ...scope, attemptId, epoch: sequence },
      packageId,
      nativeSessionId: null,
      outcome: 'STOPPED',
      repository: { branch: 'main', commit: 'b'.repeat(40) },
      files: [
        { path: 'docs/plan.md', role: 'artifact', content: Buffer.from(plan) },
        { path: 'src/bird.png', role: 'code', content: Buffer.from([0, 255, 1]) },
      ],
      sequence,
    });
  const first = await write(1, '# Plan v1\nGravity 9.8\n');
  const second = await write(2, '# Plan v2\nAdd moving pipes\n');
  nativeRows.set(`${key.pk}|RUNTIME`, {
    ...key,
    projectId,
    executionId,
    bindingId: 'binding-1',
    projectIdentity,
  });
  const execution = {
    ...key,
    sk: 'EXECUTION',
    scope,
    bindingId: 'binding-1',
    attemptId,
    epoch: 2,
    publicationEpoch: 2,
    configuration: { packageId, harness: 'codex', model: 'openai.gpt-5.6-sol' },
    publication: second,
    status: 'STOPPED',
  };
  nativeRows.set(`${key.pk}|EXECUTION`, execution);
  nativeRows.set(`${key.pk}|PUBLICATION#${'1'.padStart(16, '0')}`, {
    scope,
    bindingId: 'binding-1',
    attemptId,
    epoch: 1,
    publication: first,
  });
  const read = async (receipt, epoch) =>
    publications().read({ ...scope, attemptId, epoch }, receipt);
  const firstPlan = (await read(first, 1)).files.find((f) => f.path === 'docs/plan.md');
  const secondPlan = (await read(second, 2)).files.find((f) => f.path === 'docs/plan.md');
  return { scope, key, execution, first, second, firstPlan, secondPlan };
};

const call = (
  method,
  suffix,
  { projectId, intentId, discussionId, body, sub = MEMBER, platform = false } = {},
) =>
  handler({
    httpMethod: method,
    resource: `/api/projects/{projectId}/${platform ? 'intents' : 'native-intents'}/{intentId}${suffix}`,
    pathParameters: { projectId, intentId, ...(discussionId ? { discussionId } : {}) },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    requestContext: { authorizer: { claims: { sub, email: `${sub}@example.com` } } },
  });
const json = (res) => JSON.parse(res.body);
const revisionId = (file) => `${file.id}:${file.sha256}`;

const setup = async () => {
  const projectId = randomUUID();
  const projectIdentity = await seedProject(projectId, [MEMBER, SECOND]);
  const native = await seedNativeExecution({ projectId, projectIdentity });
  const at = { projectId, intentId: native.scope.executionId };
  const createArtifactThread = (file, publication, extra = {}) =>
    call('POST', '/discussions', {
      ...at,
      body: {
        entityType: 'artifact',
        entityId: revisionId(file),
        publicationId: publication.id,
        ...extra,
      },
    });
  return { ...native, projectId, projectIdentity, at, createArtifactThread };
};

describe('native discussion threads', () => {
  it('keeps identical file bytes in different publications on distinct exact discussion anchors', async () => {
    const f = await setup();
    const read = (receipt, epoch) =>
      publications().read({ ...f.scope, attemptId: f.execution.attemptId, epoch }, receipt);
    const oldFile = (await read(f.first, 1)).files.find((file) => file.path === 'src/bird.png');
    const newFile = (await read(f.second, 2)).files.find((file) => file.path === 'src/bird.png');
    expect(oldFile.id).toBe(newFile.id);
    expect(oldFile.sha256).toBe(newFile.sha256);
    const older = json(await f.createArtifactThread(oldFile, f.first, { publicationSequence: 1 }));
    const newer = json(await f.createArtifactThread(newFile, f.second, { publicationSequence: 2 }));
    expect(older.id).not.toBe(newer.id);
    expect(older.revision.publicationId).toBe(f.first.id);
    expect(newer.revision.publicationId).toBe(f.second.id);
    expect(
      json(await f.createArtifactThread(oldFile, f.first, { publicationSequence: 1 })).id,
    ).toBe(older.id);
    // A bogus publication cannot use the existing-hash fast path.
    expect(
      (await f.createArtifactThread(oldFile, f.first, { publicationSequence: 2 })).statusCode,
    ).toBe(404);
  });

  it('withholds a discussion list if membership is revoked during its read', async () => {
    const f = await setup();
    await f.createArtifactThread(f.secondPlan, f.second);
    vi.stubEnv('READ_STATE_TABLE', 'read-state-test');
    ddbMock.on(QueryCommand, { TableName: 'read-state-test' }).callsFake(async () => {
      await g
        .V()
        .has('Project', 'id', f.projectId)
        .outE('HAS_MEMBER')
        .where(gremlin.process.statics.inV().has('User', 'id', MEMBER))
        .drop()
        .next();
      return { Items: [] };
    });
    const result = await call('GET', '/discussions', f.at);
    expect(result.statusCode).toBe(403);
    expect(result.body).not.toContain('docs/plan.md');
  });

  it('anchors a thread to one verified revision and shares it between two members', async () => {
    const f = await setup();
    const res = await f.createArtifactThread(f.secondPlan, f.second);
    expect(res.statusCode).toBe(200);
    const thread = json(res);
    expect(thread).toMatchObject({
      entityType: 'artifact',
      entityId: revisionId(f.secondPlan),
      entityTitle: 'docs/plan.md',
      revision: {
        fileId: f.secondPlan.id,
        path: 'docs/plan.md',
        sha256: f.secondPlan.sha256,
        publicationId: f.second.id,
        publicationSequence: 2,
      },
    });
    // The second member reaches the same thread, not a duplicate.
    const again = await f.createArtifactThread(f.secondPlan, f.second, {});
    expect(
      json(
        await call('POST', '/discussions', {
          ...f.at,
          sub: SECOND,
          body: {
            entityType: 'artifact',
            entityId: revisionId(f.secondPlan),
            publicationId: f.second.id,
          },
        }),
      ).id,
    ).toBe(thread.id);
    expect(json(again).id).toBe(thread.id);

    const posted = await call('POST', '/discussions/{discussionId}/messages', {
      ...f.at,
      discussionId: thread.id,
      body: { id: `dm-${Date.now()}-abc123`, content: 'Should pipes speed up over time?' },
    });
    expect(posted.statusCode).toBe(201);
    // Fan-out uses only the protected project-qualified native channel.
    expect(connectionQueries).toContain(nativeIntentChannel(f.scope));
    expect(connectionQueries.some((c) => String(c).startsWith('intent:'))).toBe(false);
    const seen = json(
      await call('GET', '/discussions/{discussionId}/messages', {
        ...f.at,
        sub: SECOND,
        discussionId: thread.id,
      }),
    );
    expect(seen.messages.map((m) => m.content)).toEqual(['Should pipes speed up over time?']);
    const listed = json(await call('GET', '/discussions', { ...f.at, sub: SECOND }));
    expect(listed.map((d) => d.id)).toEqual([thread.id]);
  });

  it('keeps older-revision threads distinct and readable after the file changes', async () => {
    const f = await setup();
    // An older hash can never be attached to the newer publication.
    const forged = await call('POST', '/discussions', {
      ...f.at,
      body: {
        entityType: 'artifact',
        entityId: revisionId(f.firstPlan),
        publicationId: f.second.id,
      },
    });
    expect(forged.statusCode).toBe(404);
    const older = json(
      await f.createArtifactThread(f.firstPlan, f.first, { publicationSequence: 1 }),
    );
    const newer = json(await f.createArtifactThread(f.secondPlan, f.second));
    expect(older.id).not.toBe(newer.id);
    expect(older.revision).toMatchObject({ sha256: f.firstPlan.sha256, publicationSequence: 1 });
  });

  it('rejects unverified or malformed artifact anchors without creating a thread', async () => {
    const f = await setup();
    for (const body of [
      {
        entityType: 'artifact',
        entityId: `${f.secondPlan.id}:${'0'.repeat(64)}`,
        publicationId: f.second.id,
      },
      { entityType: 'artifact', entityId: revisionId(f.secondPlan), publicationId: 'f'.repeat(64) },
      { entityType: 'artifact', entityId: revisionId(f.firstPlan), publicationId: f.first.id },
    ]) {
      expect((await call('POST', '/discussions', { ...f.at, body })).statusCode).toBe(404);
    }
    expect(
      (
        await call('POST', '/discussions', {
          ...f.at,
          body: { entityType: 'artifact', entityId: 'docs/plan.md' },
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await call('POST', '/discussions', {
          ...f.at,
          body: { entityType: 'question', entityId: 'q1' },
        })
      ).statusCode,
    ).toBe(400);
    expect(json(await call('GET', '/discussions', f.at))).toEqual([]);
  });

  it('creates exactly one native root under concurrent first threads', async () => {
    const f = await setup();
    const create = async (body) => {
      for (let i = 0; i < 20; i += 1) {
        const res = await call('POST', '/discussions', { ...f.at, body });
        if (res.statusCode !== 409) return res;
      }
      throw new Error('creation never settled');
    };
    const results = await Promise.all([
      create({ entityType: 'intent' }),
      create({
        entityType: 'artifact',
        entityId: revisionId(f.secondPlan),
        publicationId: f.second.id,
      }),
      create({
        entityType: 'artifact',
        entityId: revisionId(f.secondPlan),
        publicationId: f.second.id,
      }),
    ]);
    expect(results.map((r) => r.statusCode)).toEqual([200, 200, 200]);
    expect(json(results[1]).id).toBe(json(results[2]).id);
    expect((await g.V().hasLabel('NativeDiscussionRoot').count().next()).value).toBe(1);
    expect((await g.V().hasLabel('Discussion').count().next()).value).toBe(2);
  });

  it('denies nonmembers, revoked members, recreated projects and foreign projects', async () => {
    const f = await setup();
    const thread = json(await f.createArtifactThread(f.secondPlan, f.second));
    expect((await call('GET', '/discussions', { ...f.at, sub: OUTSIDER })).statusCode).toBe(403);
    await g
      .V()
      .has('Project', 'id', f.projectId)
      .outE('HAS_MEMBER')
      .where(gremlin.process.statics.inV().has('User', 'id', SECOND))
      .drop()
      .next();
    expect(
      (
        await call('GET', '/discussions/{discussionId}/messages', {
          ...f.at,
          sub: SECOND,
          discussionId: thread.id,
        })
      ).statusCode,
    ).toBe(403);
    // Another project the member also belongs to, reusing the same execution ID.
    const otherProject = randomUUID();
    await seedProject(otherProject, [MEMBER]);
    expect(
      (await call('GET', '/discussions', { projectId: otherProject, intentId: f.at.intentId }))
        .statusCode,
    ).toBe(404);
    // A deleted and recreated project gets a new graph identity.
    nativeRows.set(`${f.key.pk}|RUNTIME`, {
      ...nativeRows.get(`${f.key.pk}|RUNTIME`),
      projectIdentity: 'vertex-from-old-project',
    });
    expect((await call('GET', '/discussions', f.at)).statusCode).toBe(403);
  });

  it('isolates two projects that reuse one execution ID', async () => {
    const f = await setup();
    const otherProject = randomUUID();
    const identity = await seedProject(otherProject, [MEMBER]);
    await seedNativeExecution({
      projectId: otherProject,
      executionId: f.at.intentId,
      projectIdentity: identity,
    });
    await call('POST', '/discussions', { ...f.at, body: { entityType: 'intent' } });
    expect(
      json(await call('GET', '/discussions', { projectId: otherProject, intentId: f.at.intentId })),
    ).toEqual([]);
    expect(
      nativeCollaborationDigest({ projectId: otherProject, executionId: f.at.intentId }),
    ).not.toBe(nativeCollaborationDigest(f.scope));
  });

  it('never serves a protected native execution through the platform intent routes', async () => {
    const f = await setup();
    const res = await call('POST', '/discussions', {
      ...f.at,
      platform: true,
      body: { entityType: 'intent' },
    });
    expect(res.statusCode).toBe(404);
    expect((await call('GET', '/discussions', { ...f.at, platform: true })).statusCode).toBe(404);
  });
});

describe('native Quorum assistance', () => {
  const assist = (f, discussionId, body = {}, sub = MEMBER) =>
    call('POST', '/discussions/{discussionId}/assist', {
      ...f.at,
      sub,
      discussionId,
      body: { requestId: `assist-${randomUUID()}`, command: 'explain', agentCli: 'kiro', ...body },
    });

  it('keeps failure, retry and out-of-order Quorum completions on the old revision without accepting workflow answers', async () => {
    const f = await setup();
    const old = json(
      await f.createArtifactThread(f.firstPlan, f.first, { publicationSequence: 1 }),
    );
    const current = json(await f.createArtifactThread(f.secondPlan, f.second));
    const protectedBefore = structuredClone([...nativeRows]);
    const requestId = `assist-${randomUUID()}`;
    expect((await assist(f, old.id, { requestId })).statusCode).toBe(202);
    const invocation = () =>
      JSON.parse(
        Buffer.from(
          agentcoreMock.commandCalls(InvokeAgentRuntimeCommand).at(-1).args[0].input.payload,
        ).toString(),
      );
    const first = invocation();
    const complete = createAssistResultHandler((read) => read(g));
    const result = (payload, status = 'completed') => ({
      native: true,
      intentId: payload.intentId,
      discussionId: payload.discussionId,
      messageId: payload.messageId,
      requestId: payload.requestId,
      attemptId: payload.attemptId,
      status,
      content:
        status === 'failed'
          ? 'Explanation failed; retry available.'
          : 'Advisory: approve the old plan.',
    });
    const failed = await complete(result(first, 'failed'));
    expect(failed.message.assistStatus).toBe('failed');
    const retry = await assist(f, old.id, { requestId }, SECOND);
    expect(retry.statusCode).toBe(202);
    const second = invocation();
    expect(second.messageId).toBe(first.messageId);
    expect(second.attemptId).not.toBe(first.attemptId);
    expect(second.nativeContext.artifact.content).toBe('# Plan v1\nGravity 9.8\n');
    expect(await complete(result(first))).toMatchObject({ ok: true, message: null });
    expect(await complete({ ...result(second), discussionId: current.id })).toMatchObject({
      message: null,
    });
    expect(await complete({ ...result(second), requestId: 'another-request' })).toMatchObject({
      message: null,
    });
    expect(await complete(result(second))).toMatchObject({
      message: { assistStatus: 'completed', content: 'Advisory: approve the old plan.' },
    });
    expect(await complete({ ...result(second), content: 'late overwrite' })).toMatchObject({
      message: null,
    });
    const history = json(
      await call('GET', '/discussions/{discussionId}/messages', {
        ...f.at,
        discussionId: old.id,
        sub: SECOND,
      }),
    );
    expect(history.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: first.messageId, assistStatus: 'completed' }),
      ]),
    );
    // Quorum may update its discussion message, never a native answer/command.
    expect([...nativeRows]).toEqual(protectedBefore);
  });

  it('sends only the selected verified revision to the shared advisory runtime', async () => {
    const f = await setup();
    const older = json(
      await f.createArtifactThread(f.firstPlan, f.first, { publicationSequence: 1 }),
    );
    const res = await assist(f, older.id, { instructions: 'What changed?' });
    expect(res.statusCode).toBe(202);
    const [invocation] = agentcoreMock.commandCalls(InvokeAgentRuntimeCommand);
    const input = invocation.args[0].input;
    expect(input.agentRuntimeArn).toBe(CORE_RUNTIME);
    expect(input).not.toHaveProperty('qualifier');
    expect(input.runtimeSessionId).toMatch(/^aidlc-discuss-native-[a-f0-9]{64}$/);
    const payload = JSON.parse(Buffer.from(input.payload).toString());
    const rootId = `native-discussions-${nativeCollaborationDigest(f.scope)}`;
    expect(payload).toMatchObject({
      command: 'discussion-assist-start',
      projectId: f.projectId,
      intentId: rootId,
      discussionId: older.id,
      assistCommand: 'explain',
      requestedCli: 'kiro',
      nativeContext: {
        executionId: f.at.intentId,
        artifact: {
          path: 'docs/plan.md',
          sha256: f.firstPlan.sha256,
          publicationId: f.first.id,
          publicationSequence: 1,
          encoding: 'utf8',
          content: '# Plan v1\nGravity 9.8\n',
          truncated: false,
        },
      },
    });
    // Quorum on the run's harness uses the run's own verified model pin.
    expect(payload.nativeContext.runModel).toEqual({ cli: 'codex', model: 'openai.gpt-5.6-sol' });
    // The newer file bytes are never supplied for the older thread.
    expect(JSON.stringify(payload)).not.toContain('moving pipes');
    // The credential grant is bound to the native root, never a platform META ID.
    const grant = verifyAgentCredentialGrant(payload.agentCredentialGrant, GRANT_SECRET);
    expect(grant).toMatchObject({
      purpose: 'discussion',
      projectId: f.projectId,
      executionId: rootId,
    });
  });

  it('requires an explicitly selected CLI because native threads have no pinned platform CLI', async () => {
    const f = await setup();
    const thread = json(
      await call('POST', '/discussions', { ...f.at, body: { entityType: 'intent' } }),
    );
    const res = await assist(f, thread.id, { agentCli: undefined });
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('agent_cli_required');
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('fails visibly instead of substituting other bytes when the revision cannot be verified', async () => {
    const f = await setup();
    const older = json(
      await f.createArtifactThread(f.firstPlan, f.first, { publicationSequence: 1 }),
    );
    nativeRows.delete(`${f.key.pk}|PUBLICATION#${'1'.padStart(16, '0')}`);
    resetRevisions();
    const res = await assist(f, older.id);
    expect(res.statusCode).toBe(202);
    expect(json(res).message).toMatchObject({ assistStatus: 'failed', authorType: 'agent' });
    expect(json(res).message.content).toContain('could not be verified');
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });

  it('denies Quorum to a revoked member', async () => {
    const f = await setup();
    const thread = json(await f.createArtifactThread(f.secondPlan, f.second));
    await g
      .V()
      .has('Project', 'id', f.projectId)
      .outE('HAS_MEMBER')
      .where(gremlin.process.statics.inV().has('User', 'id', SECOND))
      .drop()
      .next();
    expect((await assist(f, thread.id, {}, SECOND)).statusCode).toBe(403);
    expect(agentcoreMock.commandCalls(InvokeAgentRuntimeCommand)).toHaveLength(0);
  });
});
