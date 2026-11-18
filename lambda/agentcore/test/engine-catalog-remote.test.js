// The runtime's methodology catalog in remote mode, end to end: block-loader's
// exported functions (the same ones commands import) → the remote catalog →
// a mocked Lambda Invoke with real JSON serialization → the real catalog
// gateway → the same mocked S3/DynamoDB the local loader reads. Each case runs
// once locally and once remotely and must produce identical results and
// identical downstream AWS reads, while the runtime's own clients see nothing.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { GetObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createCatalogGateway } from '../../engine-data/catalog-gateway.js';
import { runWithGatewayGrant } from '../mcp/gateway-context.js';
import * as runtimeClients from '../clients.js';
import {
  listMergedBlocks,
  listReleaseBlocks,
  loadBlockBody,
  loadBlockScript,
  loadConductor,
  loadLibrary,
  loadRuntimeManifest,
  loadScriptClosure,
} from '../block-loader.js';
import { createComposePlanStart } from '../commands/compose-plan-start.js';
import { __test as releaseResolverTest } from '../../shared/release-resolver.js';
import {
  BUCKET,
  bundleA,
  installReleaseFixtures,
  pinA,
  TABLE,
  WORKFLOW_ID,
} from './helpers/release-fixture.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const KID = 'kid-1';
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
const asJson = (value) => JSON.parse(JSON.stringify(value));

const REMOTE_ENV = {
  ENGINE_DATA_FUNCTION: 'engine-data',
  AIDLC_MCP_GATEWAY_URL: 'https://gateway.example',
};

// Remote mode wiring: the Lambda client every runtime catalog call goes
// through is routed in process to the real gateway.
const installRemote = () => {
  const lambdaMock = mockClient(LambdaClient);
  const ops = [];
  const gateway = createCatalogGateway({
    verifyGrant,
    s3: new S3Client({}),
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient({})),
    bucket: BUCKET,
    blocksTable: TABLE,
  });
  lambdaMock.on(InvokeCommand).callsFake(async (input) => {
    const event = JSON.parse(Buffer.from(input.Payload).toString('utf8'));
    ops.push(event.op);
    return { Payload: Buffer.from(JSON.stringify(await gateway(event))) };
  });
  const runtimeS3 = vi.spyOn(runtimeClients.s3, 'send');
  const runtimeDdb = vi.spyOn(runtimeClients.ddb, 'send');
  return {
    ops,
    runtimeCalls: () => runtimeS3.mock.calls.length + runtimeDdb.mock.calls.length,
    clearRuntimeCalls: () => {
      runtimeS3.mockClear();
      runtimeDdb.mockClear();
    },
    restore: () => {
      lambdaMock.restore();
      runtimeS3.mockRestore();
      runtimeDdb.mockRestore();
    },
  };
};

const withEnv = async (env, fn) => {
  const saved = Object.fromEntries(Object.keys(REMOTE_ENV).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
};

const awsReads = (s3Mock, ddbMock) =>
  [
    ...s3Mock.commandCalls(GetObjectCommand).map((call) => ['s3', call.args[0].input]),
    ...ddbMock.commandCalls(GetCommand).map((call) => ['get', call.args[0].input]),
    ...ddbMock.commandCalls(QueryCommand).map((call) => ['query', call.args[0].input]),
  ]
    .map((entry) => JSON.stringify(entry))
    .toSorted();

const settle = (promise) =>
  promise.then(
    (value) => ({ ok: true, value: asJson(value) }),
    (error) => ({ ok: false, name: error?.name, code: error?.code ?? null }),
  );

// Runs `call` locally, then remotely, each from a cold release cache, and
// returns both outcomes and the AWS reads each one caused.
const bothModes = async ({ s3Mock, ddbMock }, remoteHarness, call) => {
  const run = async (env) => {
    releaseResolverTest.releaseClosureCache.clear();
    remoteHarness.clearRuntimeCalls();
    s3Mock.resetHistory();
    ddbMock.resetHistory();
    const outcome = await withEnv(env, () =>
      env.ENGINE_DATA_FUNCTION
        ? grantFor(EXECUTION).then((token) => runWithGatewayGrant(token, () => settle(call())))
        : settle(call()),
    );
    return {
      outcome,
      reads: awsReads(s3Mock, ddbMock),
      runtimeCalls: remoteHarness.runtimeCalls(),
    };
  };
  const local = await run({ ENGINE_DATA_FUNCTION: undefined, AIDLC_MCP_GATEWAY_URL: undefined });
  const remote = await run(REMOTE_ENV);
  return { local, remote };
};

const expectEquivalent = ({ local, remote }) => {
  expect(remote.outcome).toEqual(local.outcome);
  expect(remote.reads).toEqual(local.reads);
  expect(remote.runtimeCalls).toBe(0);
};

describe('remote catalog — legacy (unpinned) catalog', () => {
  const s3Mock = mockClient(S3Client);
  const ddbMock = mockClient(DynamoDBDocumentClient);
  const objects = new Map([
    [`blocks/bodies/sha256/${'1'.repeat(64)}`, '# stage body'],
    [`blocks/scripts/sha256/${'2'.repeat(64)}`, 'export default 1;'],
    ['aidlc-runtime/feature/x/core/aidlc-common/conductor.md', '# legacy conductor'],
  ]);
  const workflowRows = [
    { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#META', sourceRef: 'ref-1' },
    {
      pk: 'WF#SYSTEM#aidlc-v2',
      sk: 'V#1#PLACEMENT#build',
      stageId: 'build',
      stageTenant: 'default',
      pinnedVersion: 3,
      scopeMembership: { feature: 'EXECUTE' },
    },
    { pk: 'WF#SYSTEM#aidlc-v2', sk: 'V#1#PLACEMENT#plan', stageId: 'plan' },
  ];
  const catalog = {
    'TENANT#SYSTEM#STAGE': [{ id: 'plan', tenantId: 'SYSTEM', version: 1 }],
    'TENANT#SYSTEM#AGENT': [
      { id: 'a1', tenantId: 'SYSTEM', version: 1 },
      { id: 'a2', tenantId: 'SYSTEM', version: 1 },
    ],
    'TENANT#default#AGENT': [{ id: 'a1', tenantId: 'default', version: 4 }],
    'TENANT#SYSTEM#SCOPE': [{ id: 'feature', tenantId: 'SYSTEM', version: 1 }],
  };
  let remote;

  beforeEach(() => {
    s3Mock.reset();
    ddbMock.reset();
    process.env.ARTIFACTS_BUCKET = BUCKET;
    process.env.BLOCKS_TABLE = TABLE;
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!objects.has(input.Key)) throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
      return { Body: { transformToString: async () => objects.get(input.Key) } };
    });
    ddbMock
      .on(GetCommand)
      .callsFake((input) =>
        input.Key.pk === 'BLOCK#default#STAGE#build' && input.Key.sk === 'V#3'
          ? { Item: { id: 'build', tenantId: 'default', version: 3 } }
          : {},
      );
    // Two pages for the workflow and the SYSTEM agents: an undrained page
    // would show as a missing row in one mode only.
    ddbMock.on(QueryCommand).callsFake((input) => {
      const pk = input.ExpressionAttributeValues[':pk'];
      if (pk === 'WF#SYSTEM#aidlc-v2') {
        return input.ExclusiveStartKey
          ? { Items: workflowRows.slice(2) }
          : { Items: workflowRows.slice(0, 2), LastEvaluatedKey: { pk, sk: 'p1' } };
      }
      if (pk === 'TENANT#SYSTEM#AGENT') {
        return input.ExclusiveStartKey
          ? { Items: catalog[pk].slice(1) }
          : { Items: catalog[pk].slice(0, 1), LastEvaluatedKey: { GSI1PK: pk, x: 1 } };
      }
      return { Items: catalog[pk] ?? [] };
    });
    remote = installRemote();
  });

  afterEach(() => {
    remote.restore();
    delete process.env.ARTIFACTS_BUCKET;
    delete process.env.BLOCKS_TABLE;
  });

  it('loads the same library with default shadowing and every page drained', async () => {
    const result = await bothModes({ s3Mock, ddbMock }, remote, () =>
      loadLibrary({ workflowId: WORKFLOW_ID, workflowVersion: 1 }),
    );
    expectEquivalent(result);
    expect(result.local.outcome.value.library.agentsById).toEqual({
      a1: { id: 'a1', tenantId: 'default', version: 4 },
      a2: { id: 'a2', tenantId: 'SYSTEM', version: 1 },
    });
    expect(Object.keys(result.local.outcome.value.library.stagesById).toSorted()).toEqual([
      'build',
      'plan',
    ]);
    expect(remote.ops).toEqual(['catalog.loadLibrary']);
  });

  it('returns the same miss for an unknown workflow', async () => {
    const result = await bothModes({ s3Mock, ddbMock }, remote, () =>
      loadLibrary({ workflowId: 'nope', workflowVersion: 9 }),
    );
    expectEquivalent(result);
    expect(result.local.outcome.value).toEqual({ workflow: null, library: null });
  });

  it('serves merged blocks, bodies, scripts and the legacy conductor identically', async () => {
    const body = { tenantId: 'default', bodyRef: { s3Key: [...objects.keys()][0], bytes: 12 } };
    const sensor = { scriptRef: { s3Key: [...objects.keys()][1] } };
    for (const call of [
      () => listMergedBlocks('SCOPE'),
      () => loadBlockBody(body),
      () => loadBlockBody({ tenantId: 'SYSTEM' }),
      () => loadBlockScript(sensor),
      () => loadConductor('feature/x'),
      () => loadConductor(null),
      () => loadConductor(''),
    ]) {
      expectEquivalent(await bothModes({ s3Mock, ddbMock }, remote, call));
    }
  });

  it('reports a pinned version that is gone the same way', async () => {
    const result = await bothModes({ s3Mock, ddbMock }, remote, () =>
      loadLibrary({
        workflowId: WORKFLOW_ID,
        workflowVersion: 1,
        methodologyPins: { AGENT: { a9: { tenantId: 'default', version: 2 } } },
      }),
    );
    expectEquivalent(result);
    expect(result.local.outcome.ok).toBe(false);
  });

  it('keeps the direct runtime clients behind a tripwire in remote mode', async () => {
    await withEnv(REMOTE_ENV, async () => {
      await expect(loadRuntimeManifest('main')).rejects.toMatchObject({
        code: 'ENGINE_DATA_DIRECT_ACCESS',
      });
    });
    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(0);
  });

  it('fails closed without the MCP Gateway instead of reading directly', async () => {
    await withEnv({ ENGINE_DATA_FUNCTION: 'engine-data', AIDLC_MCP_GATEWAY_URL: '' }, async () => {
      await expect(listMergedBlocks('SCOPE')).rejects.toMatchObject({
        code: 'ENGINE_DATA_MISCONFIGURED',
      });
    });
    expect(remote.ops).toEqual([]);
    expect(remote.runtimeCalls()).toBe(0);
  });

  it('refuses a remote call outside a granted invocation', async () => {
    await withEnv(REMOTE_ENV, async () => {
      await expect(listMergedBlocks('SCOPE')).rejects.toMatchObject({
        code: 'ENGINE_DATA_GRANT_MISSING',
      });
    });
  });
});

describe('remote catalog — release-pinned catalog', () => {
  let fixtures;
  let remote;
  const stageBlock = () => bundleA.catalog.blocks.STAGE[0];
  const sensorBlock = () => bundleA.catalog.blocks.SENSOR.find((block) => block.scriptRef);

  beforeEach(async () => {
    fixtures = await installReleaseFixtures();
    remote = installRemote();
  });

  afterEach(() => {
    remote.restore();
    fixtures.s3Mock.restore();
    fixtures.ddbMock.restore();
    delete process.env.ARTIFACTS_BUCKET;
    delete process.env.BLOCKS_TABLE;
  });

  it('resolves the same release library and reads no SYSTEM row in either mode', async () => {
    const result = await bothModes(fixtures, remote, () =>
      loadLibrary({ workflowId: WORKFLOW_ID, workflowVersion: 1, methodologyRelease: pinA }),
    );
    expectEquivalent(result);
    expect(result.local.outcome.value.library.fromRelease).toBe(true);
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });

  it('serves release scopes with an immutable overlay, bodies, scripts and the conductor', async () => {
    const scope = bundleA.catalog.blocks.SCOPE[0];
    const scopeId = scope.id ?? scope.blockId;
    const pk = `BLOCK#default#SCOPE#${scopeId}`;
    fixtures.userBlockRows.set(`${pk}|V#7`, { ...scope, pk, sk: 'V#7', tenantId: 'default' });
    const pins = { SCOPE: { [scopeId]: { tenantId: 'default', version: 7 } } };
    for (const call of [
      () => listReleaseBlocks('SCOPE', pinA, pins),
      () => loadBlockBody(stageBlock(), { methodologyRelease: pinA }),
      () => loadBlockScript(sensorBlock(), { methodologyRelease: pinA }),
      () => loadConductor(null, { methodologyRelease: pinA }),
    ]) {
      const result = await bothModes(fixtures, remote, call);
      expectEquivalent(result);
      expect(result.local.outcome.ok).toBe(true);
    }
  });

  // A release sensor whose script imports sibling runtime files (2.3.3's
  // type-check imports ./aidlc-lib.ts and what that imports in turn).
  const typeCheckClosure = () => {
    const block = bundleA.catalog.blocks.SENSOR.find((sensor) => sensor.id === 'type-check');
    return {
      sensorId: 'type-check',
      entryContent: fixtures.store.get(block.scriptRef.s3Key),
      methodologyRelease: pinA,
    };
  };
  const runtimeEntry = (path) => bundleA.manifest.runtimeFiles.find((file) => file.path === path);

  it("reads a release sensor's import closure identically", async () => {
    const result = await bothModes(fixtures, remote, () => loadScriptClosure(typeCheckClosure()));
    expectEquivalent(result);
    expect(result.local.outcome.ok).toBe(true);
    expect(result.local.outcome.value.map((file) => file.relativePath)).toContain('aidlc-lib.ts');
    expect(remote.ops).toEqual(['catalog.loadScriptClosure']);
  });

  it.each([
    ['tampered', (key) => fixtures.store.set(key, '// tampered'), 'release_closure_mismatch'],
    ['missing', (key) => fixtures.store.delete(key), 'runtime_file_missing'],
  ])('reports a %s closure dependency with the same typed error', async (_label, damage, code) => {
    damage(runtimeEntry('core/tools/aidlc-lib.ts').key);
    const result = await bothModes(fixtures, remote, () => loadScriptClosure(typeCheckClosure()));
    expectEquivalent(result);
    expect(result.remote.outcome).toEqual({ ok: false, name: 'ReleaseResolverError', code });
  });

  it('rejects a tampered release object with the same typed error', async () => {
    fixtures.store.set(stageBlock().bodyRef.s3Key, '# tampered');
    const result = await bothModes(fixtures, remote, () =>
      loadBlockBody(stageBlock(), { methodologyRelease: pinA }),
    );
    expectEquivalent(result);
    expect(result.remote.outcome).toEqual({
      ok: false,
      name: 'ReleaseResolverError',
      code: 'release_closure_mismatch',
    });
  });

  it('rejects an unpublished release the same way', async () => {
    fixtures.store.delete(pinA.manifestKey);
    const result = await bothModes(fixtures, remote, () => listReleaseBlocks('SCOPE', pinA));
    expectEquivalent(result);
    expect(result.remote.outcome.code).toBe('release_not_found');
  });

  it("routes the composer's direct loader imports through engine-data", async () => {
    const store = {
      updateCompose: vi.fn(async (input) => ({ composeId: input.composeId, state: input.state })),
      appendEvent: vi.fn(async () => {}),
    };
    const start = createComposePlanStart({
      store,
      broadcast: vi.fn(async () => {}),
      availableClis: ['claude'],
      oneShot: vi.fn(async () => ({ ok: false, reason: 'cli_failed', text: '' })),
      mkdirFn: vi.fn(async () => undefined),
      log: vi.fn(),
    });
    await withEnv(REMOTE_ENV, async () => {
      const token = await grantFor(EXECUTION);
      await runWithGatewayGrant(token, () =>
        start({
          projectId: 'p-1',
          intentId: 'i-1',
          composeId: 'c-1',
          workflowId: WORKFLOW_ID,
          workflowVersion: 1,
          methodologyRelease: pinA,
          prompt: 'Build the thing',
        }),
      );
      await vi.waitFor(() => expect(store.updateCompose).toHaveBeenCalled());
    });
    expect(remote.ops).toEqual(
      expect.arrayContaining(['catalog.loadLibrary', 'catalog.listReleaseBlocks']),
    );
    expect(remote.runtimeCalls()).toBe(0);
  });
});
