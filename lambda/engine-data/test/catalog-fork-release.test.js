// A promoted fork release (custom: true, sourceRepository) must load the same
// through engine-data as it does over the runtime's own clients, and an
// unpromoted fork must still be refused by the resolver behind engine-data.
import { readFileSync } from 'node:fs';
import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { customProfile, filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import {
  buildReleaseBundle,
  publishReleaseBundle,
  releaseManifestKey,
} from '../../shared/aidlc-release.js';
import { createEngineCatalog } from '../../shared/engine-catalog.js';
import { issueGatewayGrant, verifyGatewayGrant } from '../../shared/gateway-grant.js';
import { createCatalogGateway } from '../catalog-gateway.js';
import { isCatalogKey } from '../catalog-schemas.js';

const NOW = Date.parse('2026-10-19T12:00:00.000Z');
const KID = 'kid-1';
const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
const BASE_PROFILE = 'current-stable';
const FORK = 'acme/aidlc-fork';
const EXECUTION = { mode: 'execution', projectId: 'p-1', intentId: 'i-1', executionId: 'e-1' };
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

const fixtureFiles = filesFromCompatibilityFixture({
  profileId: BASE_PROFILE,
  fixture: JSON.parse(
    readFileSync(
      new URL(
        `../../shared/test/fixtures/aidlc-compatibility/${BASE_PROFILE}.json`,
        import.meta.url,
      ),
      'utf8',
    ),
  ),
});
// One SHA per test: the resolver's closure cache is module-wide, and a fork
// pin's promotion check runs only on a cache miss.
const forkBundle = (sha) =>
  buildReleaseBundle({
    profile: customProfile({ repository: FORK, sha, baseProfileId: BASE_PROFILE }),
    files: fixtureFiles,
  });
const forkPin = ({ manifest }) => ({
  releaseId: manifest.releaseId,
  sourceSha: manifest.sourceSha,
  importerRevision: manifest.importerRevision,
  closureDigest: manifest.closureDigest,
  catalogKey: manifest.catalog.key,
  manifestKey: releaseManifestKey({
    sha: manifest.sourceSha,
    importerRevision: manifest.importerRevision,
    custom: true,
    sourceRepository: FORK,
  }),
  custom: true,
  sourceRepository: FORK,
});

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const objects = new Map();
const rows = new Map();

beforeEach(() => {
  s3Mock.reset();
  ddbMock.reset();
  objects.clear();
  rows.clear();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    objects.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!objects.has(input.Key)) {
      throw Object.assign(new Error('missing'), { name: 'NoSuchKey' });
    }
    return { Body: { transformToString: async () => objects.get(input.Key) } };
  });
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: rows.get(`${input.Key.pk}|${input.Key.sk}`) ?? undefined,
  }));
  ddbMock.on(QueryCommand).resolves({ Items: [] });
});

const publishFork = async (sha, record) => {
  const bundle = forkBundle(sha);
  await publishReleaseBundle({ s3, bucket: BUCKET, bundle });
  if (record) {
    rows.set(`AIDLC_RELEASE#${bundle.manifest.releaseId}|META`, {
      releaseId: bundle.manifest.releaseId,
      custom: true,
      ...record,
    });
  }
  return forkPin(bundle);
};

const gateway = () =>
  createCatalogGateway({ verifyGrant, s3, ddb, bucket: BUCKET, blocksTable: TABLE });
const direct = () => createEngineCatalog({ s3, ddb, bucket: BUCKET, blocksTable: TABLE });
const call = async (op, input) =>
  gateway()(
    JSON.parse(
      JSON.stringify({ op: `catalog.${op}`, args: [input], grant: await grantFor(EXECUTION) }),
    ),
  );

describe('catalog gateway — promoted fork releases', () => {
  it('admits the fork closure keys and no official-repository custom prefix', () => {
    const sha = '1'.repeat(40);
    expect(isCatalogKey(`aidlc-releases/v1/custom/acme/aidlc-fork/${sha}/i1/manifest.json`)).toBe(
      true,
    );
    expect(isCatalogKey(`aidlc-releases/v1/custom/acme/aidlc-fork/${sha}/i1/catalog.json`)).toBe(
      true,
    );
    expect(
      isCatalogKey(`aidlc-releases/v1/custom/awslabs/aidlc-workflows/${sha}/i1/manifest.json`),
    ).toBe(false);
    expect(isCatalogKey(`aidlc-releases/v1/custom/acme/../${sha}/i1/manifest.json`)).toBe(false);
    expect(isCatalogKey(`aidlc-releases/v1/custom/acme/x/y/${sha}/i1/manifest.json`)).toBe(false);
  });

  it('lists release blocks the same through engine-data as directly', async () => {
    const pin = await publishFork('2'.repeat(40), { runnable: true });
    const expected = await direct().listReleaseBlocks('SCOPE', pin);
    expect(expected.length).toBeGreaterThan(0);

    await expect(
      call('listReleaseBlocks', { type: 'SCOPE', methodologyRelease: pin }),
    ).resolves.toEqual({ ok: true, result: JSON.parse(JSON.stringify(expected)) });
  });

  it('loads the fork conductor the same through engine-data as directly', async () => {
    const pin = await publishFork('3'.repeat(40), { runnable: true });
    const expected = await direct().loadConductor(null, { methodologyRelease: pin });

    await expect(call('loadConductor', { methodologyRelease: pin })).resolves.toEqual({
      ok: true,
      result: expected,
    });
  });

  it.each([
    ['imported but not promoted', { runnable: false }],
    ['with no release record', null],
  ])('refuses a fork %s, as the direct loader does', async (_case, record) => {
    const pin = await publishFork(record ? '4'.repeat(40) : '5'.repeat(40), record);

    await expect(direct().loadConductor(null, { methodologyRelease: pin })).rejects.toMatchObject({
      code: 'release_not_runnable',
    });
    await expect(call('loadConductor', { methodologyRelease: pin })).resolves.toEqual({
      error: expect.objectContaining({ code: 'release_not_runnable' }),
    });
  });

  it.each([
    ['a custom flag with no repository', (pin) => ({ ...pin, sourceRepository: undefined })],
    ['a repository with no custom flag', (pin) => ({ ...pin, custom: undefined })],
    ['the official repository', (pin) => ({ ...pin, sourceRepository: 'awslabs/aidlc-workflows' })],
    ['a custom flag other than true', (pin) => ({ ...pin, custom: false })],
    ['a nested repository', (pin) => ({ ...pin, sourceRepository: 'acme/x/y' })],
  ])('denies a fork pin with %s', async (_case, mutate) => {
    const pin = mutate(await publishFork('6'.repeat(40), { runnable: true }));
    s3Mock.resetHistory();

    await expect(call('loadConductor', { methodologyRelease: pin })).resolves.toEqual({
      error: expect.objectContaining({ name: 'EngineDataAccessDenied', code: 'invalid_arguments' }),
    });
    expect(s3Mock.calls()).toHaveLength(0);
  });

  it('reads only the release record, never a channel pointer', async () => {
    const handler = createCatalogGateway({
      verifyGrant,
      s3,
      ddb,
      bucket: BUCKET,
      blocksTable: TABLE,
      createCatalog: ({ ddb: confined }) => ({
        listMergedBlocks: async () => {
          await confined.send(
            new GetCommand({ TableName: TABLE, Key: { pk: 'AIDLC_RELEASE#x', sk: 'META' } }),
          );
          await confined.send(
            new GetCommand({
              TableName: TABLE,
              Key: { pk: 'AIDLC_RELEASE_CHANNEL#stable', sk: 'META' },
            }),
          );
        },
      }),
    });
    const grant = await grantFor(EXECUTION);

    await expect(
      handler({ op: 'catalog.listMergedBlocks', args: [{ type: 'SCOPE' }], grant }),
    ).resolves.toEqual({
      error: expect.objectContaining({ code: 'catalog_row_not_allowed' }),
    });
    expect(ddbMock.commandCalls(GetCommand).map((c) => c.args[0].input.Key.pk)).toEqual([
      'AIDLC_RELEASE#x',
    ]);
  });
});
