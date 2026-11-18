// The runtime's custom rules, attachments, checkpoint pins and intent
// broadcasts in remote mode, end to end: the runtime functions commands use →
// the remote blob/realtime facades → a mocked Lambda Invoke with real JSON
// serialization → the real engine-data gateways → the same mocked S3,
// DynamoDB and API Gateway the local path uses. Each case runs locally and
// remotely and must produce the same result and the same downstream calls,
// while the runtime's own clients see nothing in remote mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, randomBytes, sign as cryptoSign } from 'node:crypto';
import { chmod, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, HeadObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from '@aws-sdk/client-apigatewaymanagementapi';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createBlobGateway } from '../../engine-data/blob-gateway.js';
import { createRealtimeGateway } from '../../engine-data/realtime-gateway.js';
import { createNamespaceDispatch } from '../../engine-data/gateway-common.js';
import { runWithGatewayGrant } from '../mcp/gateway-context.js';
import * as runtimeClients from '../clients.js';
import { broadcastToIntent } from '../clients.js';
import { fetchCustomRules } from '../custom-rules.js';
import { materializeAttachments, readAttachmentChunks } from '../attachments.js';
import { customRulePinsFor } from '../http-server.js';
import { createWorkflowCheckpoint } from '../commands/create-workflow-checkpoint.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const KID = 'kid-1';
const BUCKET = 'artifacts-test';
const MIB = 1024 * 1024;
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

const BASE_ENV = {
  ARTIFACTS_BUCKET: BUCKET,
  CONNECTIONS_TABLE: 'connections-test',
  WEBSOCKET_ENDPOINT: 'https://ws.example',
};
const REMOTE_ENV = {
  ...BASE_ENV,
  ENGINE_DATA_FUNCTION: 'engine-data',
  AIDLC_MCP_GATEWAY_URL: 'https://gateway.example',
};

const RULES = [
  { filename: 'a.md', s3Key: 'custom-rules/p-1/a.md' },
  { filename: 'b.md', s3Key: 'custom-rules/p-1/b.md' },
];
const BINARY = randomBytes(2 * MIB + 17);
const ATTACHMENTS = [
  {
    attachmentId: 'att-1',
    filename: 'diagram.png',
    mimeType: 'image/png',
    size: BINARY.length,
    s3Key: 'intent-attachments/committed/i-1/att-1.png',
    s3VersionId: 'v-1',
  },
  {
    attachmentId: 'att-2',
    filename: 'notes.md',
    mimeType: 'text/markdown',
    size: 5,
    s3Key: 'intent-attachments/committed/i-1/att-2.md',
    s3VersionId: 'v-2',
  },
];
const OBJECTS = {
  'custom-rules/p-1/a.md': Buffer.from('Rule A'),
  'custom-rules/p-1/b.md': Buffer.from('Rule B ✓'),
  'intent-attachments/committed/i-1/att-1.png': BINARY,
  'intent-attachments/committed/i-1/att-2.md': Buffer.from('notes'),
};

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const apiMock = mockClient(ApiGatewayManagementApiClient);
let lambdaMock;
let meta;
let ops;
let runtimeSpies;

const sdkBody = (bytes) =>
  Object.assign(Readable.from([bytes]), {
    transformToString: async () => bytes.toString('utf8'),
    transformToByteArray: async () => new Uint8Array(bytes),
  });

const serveS3 = () => {
  s3Mock.on(HeadObjectCommand).callsFake(async ({ Key }) => ({
    ContentLength: OBJECTS[Key].length,
    VersionId: `ver-${Key}`,
  }));
  s3Mock.on(GetObjectCommand).callsFake(async ({ Key, Range, VersionId }) => {
    const body = OBJECTS[Key];
    if (!Range) return { Body: sdkBody(body), VersionId };
    const [, start, end] = /^bytes=(\d+)-(\d+)$/.exec(Range).map(Number);
    const last = Math.min(end, body.length - 1);
    return {
      Body: sdkBody(body.subarray(start, last + 1)),
      VersionId,
      ContentRange: `bytes ${start}-${last}/${body.length}`,
    };
  });
};

const installRemote = () => {
  lambdaMock = mockClient(LambdaClient);
  ops = [];
  const createStore = () => ({
    getExecution: async () => meta,
    getStage: async () => null,
    getQuorumEdit: async () => null,
    getCompose: async () => null,
  });
  const dispatch = createNamespaceDispatch({
    'blob.': createBlobGateway({ verifyGrant, createStore, s3: new S3Client({}), bucket: BUCKET }),
    'realtime.': createRealtimeGateway({
      verifyGrant,
      createStore,
      withGraph: async () => {
        throw new Error('no graph needed');
      },
      ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
      api: new ApiGatewayManagementApiClient({ endpoint: 'https://ws.example' }),
      connectionsTable: 'connections-test',
    }),
  });
  lambdaMock.on(InvokeCommand).callsFake(async (input) => {
    const event = JSON.parse(Buffer.from(input.Payload).toString('utf8'));
    ops.push(event.op);
    return { Payload: Buffer.from(JSON.stringify(await dispatch(event))) };
  });
};

const awsCalls = () =>
  [
    ...s3Mock.commandCalls(HeadObjectCommand).map((c) => ['head', c.args[0].input]),
    ...s3Mock.commandCalls(GetObjectCommand).map((c) => {
      const { Range: _range, ...input } = c.args[0].input;
      return ['get', input];
    }),
    ...ddbMock.commandCalls(QueryCommand).map((c) => ['query', c.args[0].input]),
    ...apiMock.commandCalls(PostToConnectionCommand).map((c) => ['post', c.args[0].input]),
  ]
    .map((entry) => JSON.stringify(entry))
    .toSorted();

const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value: JSON.parse(JSON.stringify(value ?? null)) }),
    (error) => ({
      ok: false,
      name: error?.name,
      code: error?.code ?? null,
      message: error?.message,
    }),
  );

// Runs `call(env)` locally and then remotely (under a grant) and returns both
// outcomes with the AWS calls each caused.
const bothModes = async (call) => {
  const run = async (env) => {
    s3Mock.resetHistory();
    ddbMock.resetHistory();
    apiMock.resetHistory();
    for (const spy of runtimeSpies) spy.mockClear();
    const outcome = env.ENGINE_DATA_FUNCTION
      ? await runWithGatewayGrant(await grantFor(EXECUTION), () => settle(call(env)))
      : await settle(call(env));
    return {
      outcome,
      calls: awsCalls(),
      runtimeCalls: runtimeSpies.reduce((sum, spy) => sum + spy.mock.calls.length, 0),
    };
  };
  return { local: await run(BASE_ENV), remote: await run(REMOTE_ENV) };
};

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  apiMock.reset();
  serveS3();
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  apiMock.on(PostToConnectionCommand).resolves({});
  installRemote();
  meta = { projectId: 'p-1', intentId: 'i-1', customRules: RULES, attachments: ATTACHMENTS };
  runtimeSpies = [vi.spyOn(runtimeClients.s3, 'send'), vi.spyOn(runtimeClients.ddb, 'send')];
});

afterEach(() => {
  lambdaMock.restore();
  for (const spy of runtimeSpies) spy.mockRestore();
});

describe('remote custom rules', () => {
  it('reads the same rule bodies with the same S3 reads', async () => {
    const { local, remote } = await bothModes((env) =>
      fetchCustomRules({ customRules: RULES, env }),
    );
    expect(local.outcome).toEqual({
      ok: true,
      value: [
        { filename: 'a.md', body: 'Rule A' },
        { filename: 'b.md', body: 'Rule B ✓' },
      ],
    });
    expect(remote.outcome).toEqual(local.outcome);
    expect(remote.calls).toEqual(local.calls);
    expect(remote.runtimeCalls).toBe(0);
    expect(ops).toEqual(['blob.readCustomRules']);
  });

  it('rejects a server denial instead of returning an empty rule set', async () => {
    meta.customRules = [{ filename: 'a.md', s3Key: 'custom-rules/p-2/a.md' }];
    const { remote } = await bothModes((env) => fetchCustomRules({ customRules: RULES, env }));
    expect(remote.outcome).toMatchObject({
      ok: false,
      name: 'EngineDataAccessDenied',
      code: 'rule_key_not_allowed',
    });
    expect(remote.calls).toEqual([]);
  });

  it('fails closed without the MCP Gateway', async () => {
    const env = { ...REMOTE_ENV, AIDLC_MCP_GATEWAY_URL: undefined };
    await expect(fetchCustomRules({ customRules: RULES, env })).rejects.toMatchObject({
      code: 'ENGINE_DATA_MISCONFIGURED',
    });
    expect(ops).toEqual([]);
  });
});

describe('remote checkpoint pins', () => {
  const checkpoint = (pin, putWorkflowCheckpoint = vi.fn(async (row) => row)) =>
    createWorkflowCheckpoint(
      { projectId: 'p-1', intentId: 'i-1', executionId: 'i-1', orchestratorRunId: 'run-1' },
      {
        store: {
          getExecutionRecords: async () => ({
            meta: { ...meta, executionId: 'i-1' },
            stages: [],
            humanTasks: [],
            units: [],
          }),
          putWorkflowCheckpoint,
        },
        openEngineGraph: async () => ({ close: async () => {} }),
        snapshotArtifacts: async () => [],
        pinCustomRuleVersions: pin,
        clock: () => '2026-10-19T12:00:00.000Z',
      },
    );

  it('pins the same rule versions with the same HEADs', async () => {
    const { local, remote } = await bothModes((env) =>
      customRulePinsFor({ env, s3: new S3Client({}) })({ rules: RULES }),
    );
    expect(local.outcome.value).toEqual(
      RULES.map((rule) => ({ ...rule, versionId: `ver-${rule.s3Key}` })),
    );
    expect(remote.outcome).toEqual(local.outcome);
    expect(remote.calls).toEqual(local.calls);
    expect(ops).toEqual(['blob.pinCustomRuleVersions']);
  });

  it('keeps the previous checkpoint when remote pinning fails', async () => {
    s3Mock.on(HeadObjectCommand).resolves({ ContentLength: 1 });
    const put = vi.fn();
    const result = await runWithGatewayGrant(await grantFor(EXECUTION), () =>
      checkpoint(customRulePinsFor({ env: REMOTE_ENV }), put),
    );
    expect(result).toMatchObject({ ok: false, reason: 'checkpoint_failed' });
    expect(put).not.toHaveBeenCalled();
    expect(runtimeSpies[0]).not.toHaveBeenCalled();
  });
});

describe('remote attachments', () => {
  let workspaceDir;
  beforeEach(async () => {
    workspaceDir = await mkdtemp(path.join(tmpdir(), 'engine-blobs-'));
  });
  // Materialized reference directories are read-only by design.
  afterEach(async () => {
    for (const dir of [
      workspaceDir,
      path.join(workspaceDir, 'local'),
      path.join(workspaceDir, 'remote'),
    ]) {
      await chmod(path.join(dir, '.aidlc/references'), 0o755).catch(() => {});
    }
    await rm(workspaceDir, { recursive: true, force: true });
  });

  const files = async (dir, result) =>
    Promise.all(result.attachments.map(async (item) => readFile(path.join(dir, item.path))));

  it('reconstructs the same binary files from version-pinned chunks', async () => {
    let localFiles;
    let remoteFiles;
    const { local, remote } = await bothModes(async (env) => {
      const dir = path.join(workspaceDir, env.ENGINE_DATA_FUNCTION ? 'remote' : 'local');
      const result = await materializeAttachments({
        workspaceDir: dir,
        attachments: ATTACHMENTS,
        bucket: env.ARTIFACTS_BUCKET,
        env,
      });
      if (env.ENGINE_DATA_FUNCTION) remoteFiles = await files(dir, result);
      else localFiles = await files(dir, result);
      return result.attachments;
    });
    expect(remote.outcome).toEqual(local.outcome);
    expect(Buffer.compare(remoteFiles[0], BINARY)).toBe(0);
    expect(remoteFiles.map(String)).toEqual(localFiles.map(String));
    expect(new Set(remote.calls)).toEqual(new Set(local.calls));
    expect(ops).toEqual([
      'blob.readAttachmentChunk',
      'blob.readAttachmentChunk',
      'blob.readAttachmentChunk',
      'blob.readAttachmentChunk',
    ]);
    const ranges = s3Mock.commandCalls(GetObjectCommand).map((c) => c.args[0].input.Range);
    expect(ranges).toEqual([
      `bytes=0-${MIB - 1}`,
      `bytes=${MIB}-${2 * MIB - 1}`,
      `bytes=${2 * MIB}-${2 * MIB + 16}`,
      'bytes=0-4',
    ]);
  });

  it('leaves the previous materialization intact when a chunk is refused', async () => {
    await materializeAttachments({
      workspaceDir,
      attachments: [ATTACHMENTS[1]],
      bucket: BUCKET,
      env: BASE_ENV,
    });
    meta.attachments = [{ ...ATTACHMENTS[1], s3Key: 'intent-attachments/committed/i-2/att-2.md' }];
    const outcome = await runWithGatewayGrant(await grantFor(EXECUTION), () =>
      settle(
        materializeAttachments({
          workspaceDir,
          attachments: [{ ...ATTACHMENTS[1], filename: 'other.md' }],
          env: REMOTE_ENV,
        }),
      ),
    );
    expect(outcome).toMatchObject({ ok: false, code: 'attachment_key_not_allowed' });
    const kept = await readFile(
      path.join(workspaceDir, '.aidlc/references/att-2-notes.md'),
      'utf8',
    );
    expect(kept).toBe('notes');
  });

  it('rejects chunk gaps, overlaps, version changes and short totals', async () => {
    const attachment = { attachmentId: 'x', s3VersionId: 'v', size: 6 };
    const chunk = (offset, text, nextOffset, extra = {}) => ({
      attachmentId: 'x',
      versionId: 'v',
      offset,
      totalBytes: 6,
      bytesBase64: Buffer.from(text).toString('base64'),
      nextOffset,
      ...extra,
    });
    const serving = (chunks) => ({
      readAttachmentChunk: async ({ offset }) =>
        chunks.find((c) => c.offset === offset) ?? chunks.at(-1),
    });
    await expect(
      readAttachmentChunks(serving([chunk(0, 'abc', 3), chunk(3, 'def', null)]), attachment),
    ).resolves.toEqual(Buffer.from('abcdef'));
    for (const chunks of [
      [chunk(0, 'abc', 4), chunk(4, 'ef', null)],
      [chunk(0, 'abc', 2), chunk(2, 'cdef', null)],
      [chunk(0, 'abc', 3), chunk(3, 'def', null, { versionId: 'v2' })],
      [chunk(0, 'abc', 3), chunk(3, 'def', null, { totalBytes: 7 })],
      [chunk(0, 'abc', null)],
      [chunk(0, '', 0)],
      [chunk(0, 'abc', 3, { attachmentId: 'y' })],
    ]) {
      await expect(readAttachmentChunks(serving(chunks), attachment)).rejects.toMatchObject({
        code: 'ENGINE_DATA_ATTACHMENT_CHUNKS',
      });
    }
  });
});

describe('remote intent broadcasts', () => {
  const payload = {
    executionId: 'i-1',
    intentId: 'i-1',
    projectId: 'p-1',
    action: 'agent.units',
    unitCount: 2,
    state: 'PROMOTED',
  };

  it('posts the same frame to every connection page', async () => {
    ddbMock
      .on(QueryCommand)
      .resolvesOnce({ Items: [{ connectionId: 'c-1' }], LastEvaluatedKey: { k: 1 } })
      .resolvesOnce({ Items: [{ connectionId: 'c-2' }] })
      .resolvesOnce({ Items: [{ connectionId: 'c-1' }], LastEvaluatedKey: { k: 1 } })
      .resolvesOnce({ Items: [{ connectionId: 'c-2' }] });
    apiMock
      .on(PostToConnectionCommand, { ConnectionId: 'c-2' })
      .rejects(Object.assign(new Error('gone'), { name: 'GoneException' }));
    const { local, remote } = await bothModes((env) => broadcastToIntent('i-1', payload, { env }));
    expect(local.outcome).toEqual({ ok: true, value: null });
    expect(remote.outcome).toEqual(local.outcome);
    expect(remote.calls).toEqual(local.calls);
    expect(ops).toEqual(['realtime.broadcastIntent']);
  });

  it('logs and swallows a denial without any direct call', async () => {
    const { remote } = await bothModes((env) =>
      broadcastToIntent('i-1', { ...payload, projectId: 'p-2' }, { env }),
    );
    expect(remote.outcome).toEqual({ ok: true, value: null });
    expect(remote.calls).toEqual([]);
    expect(remote.runtimeCalls).toBe(0);
  });

  it('stays best-effort when misconfigured or outside a grant', async () => {
    await expect(
      broadcastToIntent('i-1', payload, {
        env: { ...REMOTE_ENV, AIDLC_MCP_GATEWAY_URL: undefined },
      }),
    ).resolves.toBeUndefined();
    await expect(broadcastToIntent('i-1', payload, { env: REMOTE_ENV })).resolves.toBeUndefined();
    expect(ops).toEqual([]);
    expect(ddbMock.calls()).toHaveLength(0);
    expect(apiMock.calls()).toHaveLength(0);
  });
});
