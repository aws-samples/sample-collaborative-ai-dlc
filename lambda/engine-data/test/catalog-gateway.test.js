import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { ReleaseResolverError } from '../../shared/release-resolver.js';
import { readReleaseScriptClosure } from '../../shared/release-script-closure.js';
import { createCatalogGateway } from '../catalog-gateway.js';
import { isCatalogKey, isCatalogRef } from '../catalog-schemas.js';
import { createNamespaceDispatch } from '../gateway-common.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const KID = 'kid-1';
const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
const SHA = 'a'.repeat(40);
const HEX = 'b'.repeat(64);
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
const EXECUTION = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' };
const DISCUSSION = { mode: 'discussion', projectId: 'p-1', intentId: 'i-1' };
const pin = {
  releaseId: 'aidlc:1',
  sourceSha: SHA,
  importerRevision: 1,
  closureDigest: HEX,
  catalogKey: `aidlc-releases/v1/${SHA}/i1/catalog.json`,
  manifestKey: `aidlc-releases/v1/${SHA}/i1/manifest.json`,
};

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));

const gatewayWith = (overrides = {}) =>
  createCatalogGateway({
    verifyGrant,
    s3,
    ddb,
    bucket: BUCKET,
    blocksTable: TABLE,
    ...overrides,
  });

const call = async (handler, op, input, scope = EXECUTION) =>
  handler(
    JSON.parse(
      JSON.stringify({ op: `catalog.${op}`, args: [input], grant: await grantFor(scope) }),
    ),
  );

const denial = (code) => ({
  error: expect.objectContaining({ name: 'EngineDataAccessDenied', code }),
});

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  s3Mock.on(GetObjectCommand).resolves({ Body: { transformToString: async () => 'text' } });
  ddbMock.on(QueryCommand).resolves({ Items: [] });
  ddbMock.on(GetCommand).resolves({});
});

describe('catalog gateway — grant and op checks', () => {
  it('requires a verified engine grant', async () => {
    const handler = gatewayWith();
    await expect(
      handler({ op: 'catalog.listMergedBlocks', args: [{ type: 'SCOPE' }] }),
    ).resolves.toEqual(denial('missing_grant'));
    await expect(
      handler({ op: 'catalog.listMergedBlocks', args: [{ type: 'SCOPE' }], grant: 'forged' }),
    ).resolves.toEqual(denial('grant_invalid'));
    await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' }, DISCUSSION)).resolves.toEqual(
      denial('grant_mode_not_allowed'),
    );
  });

  it('serves any engine grant without an execution META read', async () => {
    const handler = gatewayWith();
    for (const scope of [
      EXECUTION,
      { ...EXECUTION, mode: 'conflict' },
      { ...EXECUTION, mode: 'stage', stageId: 'build' },
    ]) {
      await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' }, scope)).resolves.toEqual({
        ok: true,
        result: [],
      });
    }
    for (const entry of ddbMock.commandCalls(QueryCommand)) {
      expect(entry.args[0].input.TableName).toBe(TABLE);
    }
  });

  it('refuses ops outside the allowlist and malformed arguments', async () => {
    const handler = gatewayWith();
    await expect(call(handler, 'loadRuntimeManifest', { ref: 'main' })).resolves.toEqual(
      denial('op_not_allowed'),
    );
    await expect(call(handler, 'getObject', { key: 'x' })).resolves.toEqual(
      denial('op_not_allowed'),
    );
    const grant = await grantFor(EXECUTION);
    await expect(
      handler({ op: 'catalog.listMergedBlocks', args: [{ type: 'SCOPE' }, {}], grant }),
    ).resolves.toEqual(denial('invalid_arguments'));
    await expect(
      handler({
        op: 'catalog.listMergedBlocks',
        args: [JSON.parse('{"type":"SCOPE","__proto__":{"x":1}}')],
        grant,
      }),
    ).resolves.toEqual(denial('invalid_arguments'));
    await expect(
      call(handler, 'listMergedBlocks', { type: 'SCOPE', bucket: 'other' }),
    ).resolves.toEqual(denial('invalid_arguments'));
    await expect(call(handler, 'listMergedBlocks', { type: 'WORKFLOW' })).resolves.toEqual(
      denial('invalid_arguments'),
    );
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('dispatches by namespace and denies an op outside every namespace', async () => {
    const catalog = vi.fn(async () => ({ ok: true, result: 'catalog' }));
    const store = vi.fn(async () => ({ ok: true, result: 'store' }));
    const audit = vi.fn();
    const handler = createNamespaceDispatch({ 'store.': store, 'catalog.': catalog }, { audit });
    await expect(handler({ op: 'catalog.loadConductor' })).resolves.toEqual({
      ok: true,
      result: 'catalog',
    });
    await expect(handler({ op: 'blob.readCustomRules' })).resolves.toEqual(
      denial('op_not_allowed'),
    );
    await expect(handler({})).resolves.toEqual(denial('op_not_allowed'));
    expect(store).not.toHaveBeenCalled();
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ decision: 'deny' }));
  });
});

describe('catalog gateway — tenants and key grammar', () => {
  it('rejects tenants other than SYSTEM and default in input', async () => {
    const handler = gatewayWith();
    const ref = { s3Key: `blocks/bodies/sha256/${HEX}` };
    await expect(call(handler, 'loadBlockBody', { tenantId: 'acme', ref })).resolves.toEqual(
      denial('invalid_arguments'),
    );
    await expect(
      call(handler, 'loadLibrary', {
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        methodologyPins: { STAGE: { build: { tenantId: 'acme', version: 1 } } },
      }),
    ).resolves.toEqual(denial('invalid_arguments'));
    await expect(
      call(handler, 'listReleaseBlocks', {
        type: 'SCOPE',
        methodologyRelease: pin,
        methodologyPins: { SCOPE: { s: { tenantId: 'SYSTEM#x', version: 1 } } },
      }),
    ).resolves.toEqual(denial('invalid_arguments'));
    expect(s3Mock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('denies a foreign tenant recovered from a stored placement row', async () => {
    ddbMock.on(QueryCommand).callsFake((input) =>
      input.ExpressionAttributeValues[':pk'] === 'WF#default#aidlc-v2'
        ? {
            Items: [
              { pk: 'WF#default#aidlc-v2', sk: 'V#1#META' },
              {
                pk: 'WF#default#aidlc-v2',
                sk: 'V#1#PLACEMENT#build',
                stageId: 'build',
                stageTenant: 'acme',
                pinnedVersion: 1,
              },
            ],
          }
        : { Items: [] },
    );
    const audit = vi.fn();
    const handler = gatewayWith({ audit });
    await expect(
      call(handler, 'loadLibrary', { workflowId: 'aidlc-v2', workflowVersion: 1 }),
    ).resolves.toEqual(denial('catalog_row_not_allowed'));
    expect(
      ddbMock
        .commandCalls(GetCommand)
        .filter((entry) => entry.args[0].input.Key.pk.includes('acme')),
    ).toHaveLength(0);
    // The audit carries names and decision only, never keys or ids from rows.
    expect(JSON.stringify(audit.mock.calls)).not.toContain('acme');
  });

  it.each([
    ['custom rules', 'custom-rules/p-1/rule.md'],
    ['an attachment', 'intent-attachments/committed/i-1/a-1'],
    ['a traversal', `blocks/bodies/sha256/../../custom-rules/p-1/${HEX}`],
    ['a non-hex digest', `blocks/bodies/sha256/${'G'.repeat(64)}`],
    ['an uppercase digest', `blocks/bodies/sha256/${'B'.repeat(64)}`],
    [
      'the official repository under the custom prefix',
      `aidlc-releases/v1/custom/awslabs/aidlc-workflows/${SHA}/i1/catalog.json`,
    ],
    ['a malformed fork owner', `aidlc-releases/v1/custom/-o/r/${SHA}/i1/catalog.json`],
    ['a staging key', `staging/blocks/bodies/sha256/${HEX}`],
    ['an encoded key', `blocks%2Fbodies%2Fsha256%2F${HEX}`],
  ])('denies a caller-supplied ref to %s', async (_label, s3Key) => {
    const handler = gatewayWith();
    await expect(call(handler, 'loadBlockBody', { ref: { s3Key } })).resolves.toEqual(
      denial('invalid_arguments'),
    );
    await expect(
      call(handler, 'listReleaseBlocks', {
        type: 'SCOPE',
        methodologyRelease: { ...pin, catalogKey: s3Key },
      }),
    ).resolves.toEqual(denial('invalid_arguments'));
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it.each([['..'], ['a//b'], ['/main'], ['main/'], ['a\\b'], ['a\u0000b'], ['./main'], ['']])(
    'denies the conductor ref %j',
    async (ref) => {
      const handler = gatewayWith();
      await expect(call(handler, 'loadConductor', { ref })).resolves.toEqual(
        denial('invalid_arguments'),
      );
      expect(s3Mock.calls()).toHaveLength(0);
    },
  );

  it('keeps the legacy empty conductor for no ref', async () => {
    const handler = gatewayWith();
    await expect(call(handler, 'loadConductor', { ref: null })).resolves.toEqual({
      ok: true,
      result: '',
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('keeps legitimate slash-separated refs and reads the fixed conductor path', async () => {
    const handler = gatewayWith();
    await expect(call(handler, 'loadConductor', { ref: 'release/v2.1' })).resolves.toEqual({
      ok: true,
      result: 'text',
    });
    expect(s3Mock.commandCalls(GetObjectCommand)[0].args[0].input).toEqual({
      Bucket: BUCKET,
      Key: 'aidlc-runtime/release/v2.1/core/aidlc-common/conductor.md',
    });
  });

  it('matches the documented catalog key grammar', () => {
    expect(isCatalogKey(`blocks/scripts/sha256/${HEX}`)).toBe(true);
    expect(isCatalogKey(`aidlc-releases/v1/${SHA}/i12/manifest.json`)).toBe(true);
    expect(isCatalogKey(`aidlc-releases/v1/runtime/sha256/${HEX}`)).toBe(true);
    expect(isCatalogKey(`aidlc-releases/v1/${SHA}/i0/manifest.json`)).toBe(false);
    expect(isCatalogKey(`aidlc-releases/v1/${SHA}/i1/objects.json`)).toBe(false);
    expect(isCatalogKey('aidlc-runtime/main/manifest.json')).toBe(false);
    expect(isCatalogKey('aidlc-runtime/../core/aidlc-common/conductor.md')).toBe(false);
    expect(isCatalogRef('feature/x')).toBe(true);
    expect(isCatalogRef('x'.repeat(513))).toBe(false);
  });
});

describe('catalog gateway — a release sensor script closure', () => {
  const closureInput = (overrides = {}) => ({
    sensorId: 'type-check',
    entryContent: 'import { lib } from "./aidlc-lib.ts";',
    methodologyRelease: pin,
    ...overrides,
  });

  it.each([
    ['a sensor id that leaves tools/', { sensorId: '../../secrets/x' }],
    ['a sensor id with a separator', { sensorId: 'a/b' }],
    ['an empty sensor id', { sensorId: '' }],
    ['no release pin', { methodologyRelease: null }],
    ['a caller-chosen entry path', { entryPath: 'core/tools/aidlc-lib.ts' }],
    ['a caller-chosen key', { key: `aidlc-releases/v1/runtime/sha256/${HEX}` }],
    ['an oversized entry', { entryContent: 'x'.repeat(1024 * 1024 + 1) }],
  ])('refuses %s', async (_label, overrides) => {
    const handler = gatewayWith();
    await expect(call(handler, 'loadScriptClosure', closureInput(overrides))).resolves.toEqual(
      denial('invalid_arguments'),
    );
    expect(s3Mock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('serves a stage grant, the grant run-stage sensors run under', async () => {
    const handler = gatewayWith({
      createCatalog: () => ({ loadScriptClosure: async (input) => [input.sensorId] }),
    });
    await expect(
      call(handler, 'loadScriptClosure', closureInput(), {
        ...EXECUTION,
        mode: 'stage',
        stageId: 'build',
      }),
    ).resolves.toEqual({ ok: true, result: ['type-check'] });
  });

  // A runtime file key recovered from a manifest is read through the confined
  // client like any other catalog object; one outside the grammar is a denial
  // even though the closure reader wraps it as an unreadable dependency.
  it('denies a dependency read outside the catalog key grammar', async () => {
    const handler = gatewayWith({
      createCatalog: ({ s3: confined }) => ({
        loadScriptClosure: ({ entryContent }) =>
          readReleaseScriptClosure({
            entryPath: 'core/tools/aidlc-sensor-type-check.ts',
            entryContent,
            loadClosure: async () => ({ runtimeFiles: new Set(['core/tools/aidlc-lib.ts']) }),
            readRuntimeFile: () =>
              confined.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'custom-rules/p/x.md' })),
          }),
      }),
    });
    await expect(call(handler, 'loadScriptClosure', closureInput())).resolves.toEqual(
      denial('catalog_key_not_allowed'),
    );
    expect(s3Mock.calls()).toHaveLength(0);
  });
});

describe('catalog gateway — confined loader clients', () => {
  const withFakeCatalog = (run) =>
    gatewayWith({
      createCatalog: (clients) => ({ listMergedBlocks: () => run(clients) }),
    });

  it.each([
    [
      'another bucket',
      ({ s3: c }) =>
        c.send(new GetObjectCommand({ Bucket: 'other', Key: `blocks/bodies/sha256/${HEX}` })),
    ],
    [
      'a non-catalog key',
      ({ s3: c }) => c.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'custom-rules/p/x.md' })),
    ],
    [
      'a versioned read',
      ({ s3: c }) =>
        c.send(
          new GetObjectCommand({
            Bucket: BUCKET,
            Key: `blocks/bodies/sha256/${HEX}`,
            VersionId: 'v1',
          }),
        ),
    ],
    [
      'a write',
      ({ s3: c }) =>
        c.send(
          new PutObjectCommand({ Bucket: BUCKET, Key: `blocks/bodies/sha256/${HEX}`, Body: 'x' }),
        ),
    ],
    ['a scan', ({ ddb: c }) => c.send(new ScanCommand({ TableName: TABLE }))],
    [
      'another table',
      ({ ddb: c }) =>
        c.send(
          new GetCommand({ TableName: 'process', Key: { pk: 'BLOCK#SYSTEM#STAGE#x', sk: 'V#1' } }),
        ),
    ],
    [
      'a foreign block tenant',
      ({ ddb: c }) =>
        c.send(new GetCommand({ TableName: TABLE, Key: { pk: 'BLOCK#acme#STAGE#x', sk: 'V#1' } })),
    ],
    [
      'a non-block row',
      ({ ddb: c }) =>
        c.send(new GetCommand({ TableName: TABLE, Key: { pk: 'RELEASE#x', sk: 'META' } })),
    ],
    [
      'a foreign catalog index',
      ({ ddb: c }) =>
        c.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': 'TENANT#acme#STAGE' },
          }),
        ),
    ],
    [
      'another index',
      ({ ddb: c }) =>
        c.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: 'GSI2',
            KeyConditionExpression: 'GSI1PK = :pk',
            ExpressionAttributeValues: { ':pk': 'TENANT#SYSTEM#STAGE' },
          }),
        ),
    ],
    [
      'a filtered query',
      ({ ddb: c }) =>
        c.send(
          new QueryCommand({
            TableName: TABLE,
            IndexName: 'GSI1',
            KeyConditionExpression: 'GSI1PK = :pk',
            FilterExpression: 'x = :pk',
            ExpressionAttributeValues: { ':pk': 'TENANT#SYSTEM#STAGE' },
          }),
        ),
    ],
  ])('denies %s the loader would issue', async (_label, run) => {
    const handler = withFakeCatalog(run);
    await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' })).resolves.toEqual(
      expect.objectContaining({
        error: expect.objectContaining({ name: 'EngineDataAccessDenied' }),
      }),
    );
    expect(s3Mock.calls()).toHaveLength(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('reports a confinement denial the loader wrapped in a release error as a denial', async () => {
    const handler = withFakeCatalog(async ({ s3: c }) => {
      try {
        await c.send(new GetObjectCommand({ Bucket: BUCKET, Key: 'custom-rules/p/x.md' }));
      } catch (error) {
        throw new ReleaseResolverError('release_object_unreadable', 'wrapped', { cause: error });
      }
    });
    await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' })).resolves.toEqual(
      denial('catalog_key_not_allowed'),
    );
  });

  it('lets the reads the loader issues through', async () => {
    const handler = withFakeCatalog(async ({ s3: s, ddb: d }) => {
      await s.send(
        new GetObjectCommand({ Bucket: BUCKET, Key: `aidlc-releases/v1/${SHA}/i1/manifest.json` }),
      );
      await d.send(
        new GetCommand({ TableName: TABLE, Key: { pk: 'BLOCK#default#STAGE#x', sk: 'V#latest' } }),
      );
      await d.send(
        new QueryCommand({
          TableName: TABLE,
          KeyConditionExpression: 'pk = :pk AND begins_with(sk, :v)',
          ExpressionAttributeValues: { ':pk': 'WF#default#aidlc-v2', ':v': 'V#3#' },
          ExclusiveStartKey: { pk: 'WF#default#aidlc-v2', sk: 'V#3#META' },
        }),
      );
      return 'ok';
    });
    await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' })).resolves.toEqual({
      ok: true,
      result: 'ok',
    });
  });
});

describe('catalog gateway — response bound and configuration', () => {
  it('returns an explicit size error instead of truncating', async () => {
    ddbMock.on(QueryCommand).resolves({ Items: [{ id: 'big', body: 'x'.repeat(4096) }] });
    const handler = gatewayWith({ maxResponseBytes: 1024 });
    await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' })).resolves.toEqual({
      error: expect.objectContaining({ name: 'EngineCatalogError', code: 'response_too_large' }),
    });
  });

  it('fails closed without a configured bucket or blocks table', async () => {
    const handler = gatewayWith({ bucket: undefined });
    await expect(call(handler, 'listMergedBlocks', { type: 'SCOPE' })).resolves.toEqual({
      error: expect.objectContaining({ code: 'catalog_misconfigured' }),
    });
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('returns loader errors by name and code', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    const handler = gatewayWith();
    await expect(
      call(handler, 'loadLibrary', {
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        methodologyRelease: pin,
      }),
    ).resolves.toEqual({
      error: expect.objectContaining({ name: 'ReleaseResolverError', code: 'release_not_found' }),
    });
  });
});
