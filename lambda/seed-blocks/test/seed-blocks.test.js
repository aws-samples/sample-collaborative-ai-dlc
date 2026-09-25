import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { CORE_FILES } from '../../shared/test/fixtures/repo-files.js';
import { buildFromFiles } from '../../shared/block-mappers.js';
import { filesFromCompatibilityFixture } from '../../shared/aidlc-compatibility.js';
import {
  AIDLC_COMPATIBILITY_PROFILES,
  customProfile,
} from '../../shared/aidlc-compatibility-profiles.js';
import { fetchCoreFiles } from '../../shared/repo-fetch.js';
import { AIDLC_RELEASE_IMPORTER_REVISION } from '../../shared/aidlc-release.js';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';
const REF = 'a'.repeat(40);

// Mock the repo fetch so the seed reads the fixture tree, not the network.
vi.mock('../../shared/repo-fetch.js', () => ({
  fetchCoreFiles: vi.fn(async () => CORE_FILES),
}));

const RELEASE_PROFILE = 'current-stable';
const releaseFiles = () =>
  filesFromCompatibilityFixture({
    profileId: RELEASE_PROFILE,
    fixture: JSON.parse(
      readFileSync(
        new URL(
          `../../shared/test/fixtures/aidlc-compatibility/${RELEASE_PROFILE}.json`,
          import.meta.url,
        ),
        'utf8',
      ),
    ),
  });

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

const tableStore = new Map();
const s3Store = new Map();
const keyOf = (pk, sk) => `${pk}|${sk}`;

const condFail = () => {
  const e = new Error('The conditional request failed');
  e.name = 'ConditionalCheckFailedException';
  return e;
};

const installFakes = () => {
  ddbMock.reset();
  s3Mock.reset();
  tableStore.clear();
  s3Store.clear();

  ddbMock.on(PutCommand).callsFake((input) => {
    const item = input.Item;
    const k = keyOf(item.pk, item.sk);
    if (input.ConditionExpression === 'attribute_not_exists(pk)' && tableStore.has(k)) {
      throw condFail();
    }
    tableStore.set(k, { ...item });
    return {};
  });

  ddbMock.on(ScanCommand).callsFake(() => {
    const items = [...tableStore.values()].filter(
      (i) => i.pk.startsWith('BLOCK#SYSTEM#') || i.pk.startsWith('WF#SYSTEM#'),
    );
    return { Items: items.map((i) => ({ pk: i.pk, sk: i.sk })) };
  });

  ddbMock.on(BatchWriteCommand).callsFake((input) => {
    for (const reqs of Object.values(input.RequestItems)) {
      for (const req of reqs) {
        if (req.DeleteRequest) {
          const { pk, sk } = req.DeleteRequest.Key;
          tableStore.delete(keyOf(pk, sk));
        } else if (req.PutRequest) {
          const item = req.PutRequest.Item;
          tableStore.set(keyOf(item.pk, item.sk), { ...item });
        }
      }
    }
    return {};
  });

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    // Honour IfNoneMatch so immutable-write paths exercise their real
    // already-exists branch instead of silently overwriting.
    if (input.IfNoneMatch === '*' && s3Store.has(input.Key)) {
      const error = new Error('At least one of the pre-conditions you specified did not hold');
      error.name = 'PreconditionFailed';
      error.$metadata = { httpStatusCode: 412 };
      throw error;
    }
    s3Store.set(input.Key, input.Body);
    return {};
  });

  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!s3Store.has(input.Key)) {
      const error = new Error('The specified key does not exist.');
      error.name = 'NoSuchKey';
      error.$metadata = { httpStatusCode: 404 };
      throw error;
    }
    return { Body: { transformToString: async () => String(s3Store.get(input.Key)) } };
  });
};

// The blocks + workflow the fixtures compile to (the seed should write these).
const { blocks: FIXTURE_BLOCKS, runtimeFiles: FIXTURE_RUNTIME } = buildFromFiles(CORE_FILES);
const BLOCK_COUNT = FIXTURE_BLOCKS.length;
const TOTAL = BLOCK_COUNT + 1; // + the one workflow

let handler;

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  process.env.ARTIFACTS_BUCKET = ARTIFACTS_BUCKET;
  process.env.AIDLC_REPO_REF = REF;
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  fetchCoreFiles.mockImplementation(async () => CORE_FILES);
  installFakes();
});

describe('seed-blocks handler', () => {
  it('dry-run writes nothing but reports every block + the workflow', async () => {
    const result = await handler({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.ref).toBe(REF);
    expect(result.seeded).toHaveLength(TOTAL);
    expect(result.skipped).toHaveLength(0);
    expect(tableStore.size).toBe(0);
    expect(s3Store.size).toBe(0);
  });

  it('seeds each block as a SYSTEM V#latest + V#1 pair', async () => {
    const result = await handler({});
    expect(result.seeded).toHaveLength(TOTAL);
    expect([...tableStore.values()].find((item) => item.blockType === 'STAGE')?.sourceRef).toBe(
      REF,
    );
    expect(result.skipped).toHaveLength(0);
    for (const block of FIXTURE_BLOCKS) {
      const pk = `BLOCK#SYSTEM#${block.type}#${block.id}`;
      expect(tableStore.has(`${pk}|V#latest`)).toBe(true);
      expect(tableStore.has(`${pk}|V#1`)).toBe(true);
      expect(tableStore.get(`${pk}|V#latest`).GSI1PK).toBe(`TENANT#SYSTEM#${block.type}`);
      expect(tableStore.get(`${pk}|V#1`).GSI1PK).toBeUndefined();
    }
  });

  it('externalizes every block body to S3 and stores a pointer, not inline text', async () => {
    await handler({});
    for (const block of FIXTURE_BLOCKS.filter((b) => b.body)) {
      const item = tableStore.get(`BLOCK#SYSTEM#${block.type}#${block.id}|V#latest`);
      expect(item.bodyRef).toBeTruthy();
      expect(item.bodyRef.s3Key).toMatch(/^blocks\/bodies\/sha256\//);
      expect(item.body).toBeUndefined();
      expect(s3Store.get(item.bodyRef.s3Key)).toBe(block.body);
    }
  });

  it('attaches each sensor script as a scriptRef pointing at S3', async () => {
    await handler({});
    const linter = tableStore.get('BLOCK#SYSTEM#SENSOR#linter|V#latest');
    expect(linter.scriptRef).toBeTruthy();
    expect(linter.scriptRef.s3Key).toMatch(/^blocks\/scripts\/sha256\//);
    expect(s3Store.get(linter.scriptRef.s3Key)).toContain('linter sensor script');
    // A block with no script carries no scriptRef.
    const agent = tableStore.get('BLOCK#SYSTEM#AGENT#aidlc-product-agent|V#latest');
    expect(agent.scriptRef).toBeUndefined();
  });

  it('seeds the new editable SKILL and TEMPLATE block types', async () => {
    await handler({});
    const skill = tableStore.get('BLOCK#SYSTEM#SKILL#aidlc-replay|V#latest');
    expect(skill).toBeTruthy();
    expect(skill.userInvocable).toBe(true);
    expect(skill.classification).toBe('read-only');
    const tmpl = tableStore.get('BLOCK#SYSTEM#TEMPLATE#onboarding|V#latest');
    expect(tmpl).toBeTruthy();
    expect(tmpl.bodyRef).toBeTruthy();
  });

  it('seeds the stage authored fields (reviewer, brownfield conditionalOn) — flat', async () => {
    await handler({});
    const stage = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(stage.reviewer).toBe('aidlc-architecture-reviewer-agent');
    expect(stage.reviewerMaxIterations).toBe(2);
    const archEdge = stage.consumes.find((i) => i.artifact === 'architecture');
    expect(archEdge.conditionalOn).toBe('brownfield');
    const intent = tableStore.get('BLOCK#SYSTEM#STAGE#intent-capture|V#latest');
    expect(intent.reviewer).toBeNull();
  });

  it('writes the internal runtime snapshot under aidlc-runtime/<ref>/ + a manifest', async () => {
    const result = await handler({});
    expect(result.runtimeFiles).toBe(FIXTURE_RUNTIME.size);
    for (const repoPath of FIXTURE_RUNTIME.keys()) {
      expect(s3Store.get(`aidlc-runtime/${REF}/${repoPath}`)).toBeTruthy();
    }
    const manifest = JSON.parse(s3Store.get(`aidlc-runtime/${REF}/manifest.json`));
    expect(manifest.ref).toBe(REF);
    expect(manifest.runtimeFiles).toContain('core/aidlc-common/protocols/stage-protocol.md');
    expect(manifest.sensorScripts).toContain('core/tools/aidlc-sensor-linter.ts');
  });

  it('writes a body-free methodology catalog for historical exports', async () => {
    const result = await handler({});
    const key = `aidlc-catalogs/v1/${REF}.json`;
    expect(result.methodologyCatalog).toBe(key);
    const catalog = JSON.parse(s3Store.get(key));
    expect(catalog.ref).toBe(REF);
    expect(catalog.workflow.id).toBe('aidlc-v2');
    expect(catalog.blocks.STAGE.length).toBeGreaterThan(0);
    expect(catalog.blocks.STAGE[0].body).toBeUndefined();
    expect(catalog.blocks.STAGE[0].bodyRef.s3Key).toMatch(/^blocks\/bodies\/sha256\//);
  });

  it('does not seed runtime files as editable blocks', async () => {
    await handler({});
    expect(tableStore.has('BLOCK#SYSTEM#TOOL#aidlc-orchestrate|V#latest')).toBe(false);
    const blockKeys = [...tableStore.keys()].filter((k) => k.startsWith('BLOCK#'));
    expect(blockKeys.some((k) => k.includes('orchestrate'))).toBe(false);
  });

  it('is idempotent: a second run skips everything already seeded', async () => {
    await handler({});
    const sizeAfterFirst = tableStore.size;
    const result = await handler({});
    expect(result.seeded).toHaveLength(0);
    expect(result.skipped).toHaveLength(TOTAL);
    expect(tableStore.size).toBe(sizeAfterFirst);
  });

  it('uses the ref from the event, overriding the env default', async () => {
    const overrideRef = 'b'.repeat(40);
    const result = await handler({ ref: overrideRef });
    expect(result.ref).toBe(overrideRef);
    expect(s3Store.has(`aidlc-runtime/${overrideRef}/manifest.json`)).toBe(true);
  });

  it('retains the previous commit catalog across a SYSTEM reseed', async () => {
    const nextRef = 'b'.repeat(40);
    await handler({ ref: REF });
    await handler({ ref: nextRef, reseed: true });

    expect(s3Store.has(`aidlc-catalogs/v1/${REF}.json`)).toBe(true);
    expect(s3Store.has(`aidlc-catalogs/v1/${nextRef}.json`)).toBe(true);
  });

  it('seeds the aidlc-v2 workflow partition (META + phases + placements)', async () => {
    await handler({});
    const pk = 'WF#SYSTEM#aidlc-v2';
    const meta = tableStore.get(`${pk}|META`);
    expect(meta).toBeTruthy();
    expect(meta.status).toBe('PUBLISHED');
    expect(meta.GSI1PK).toBe('TENANT#SYSTEM#WORKFLOW');
    expect(tableStore.has(`${pk}|V#1#META`)).toBe(true);
    expect(tableStore.has(`${pk}|PHASE#02#ideation`)).toBe(true);
    expect(tableStore.has(`${pk}|PLACEMENT#intent-capture`)).toBe(true);
    const snapshot = tableStore.get(`${pk}|V#1#PLACEMENT#intent-capture`);
    expect(snapshot.pinnedVersion).toBe(1);
    // SCOPEREF rows — the compiled scopeGrid (create-project scope picker) is
    // empty without them.
    expect(tableStore.has(`${pk}|SCOPEREF#feature`)).toBe(true);
    expect(tableStore.has(`${pk}|SCOPEREF#mvp`)).toBe(true);
    expect(tableStore.has(`${pk}|V#1#SCOPEREF#feature`)).toBe(true);
  });
});

describe('seed-blocks reseed mode', () => {
  const seedStale = () => {
    tableStore.set('BLOCK#SYSTEM#STAGE#application-design|V#latest', {
      pk: 'BLOCK#SYSTEM#STAGE#application-design',
      sk: 'V#latest',
      tenantId: 'SYSTEM',
      blockType: 'STAGE',
      blockId: 'application-design',
      name: 'Application Design',
      reviewer: undefined,
    });
    tableStore.set('WF#SYSTEM#aidlc-v2|GROUPING#01#ideation', {
      pk: 'WF#SYSTEM#aidlc-v2',
      sk: 'GROUPING#01#ideation',
    });
    // A customer fork that must NEVER be touched by a SYSTEM reseed.
    tableStore.set('BLOCK#default#STAGE#my-fork|V#latest', {
      pk: 'BLOCK#default#STAGE#my-fork',
      sk: 'V#latest',
      tenantId: 'default',
      name: 'My Fork',
    });
    tableStore.set('WF#default#my-wf|META', {
      pk: 'WF#default#my-wf',
      sk: 'META',
      tenantId: 'default',
    });
  };

  it('refreshes a stale baseline the insert-only path would skip', async () => {
    seedStale();
    await handler({});
    const afterInsert = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(afterInsert.reviewer).toBeUndefined(); // insert-only left the stale row

    const result = await handler({ reseed: true });
    expect(result.reseed).toBe(true);
    expect(result.cleared).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0);
    const refreshed = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(refreshed.reviewer).toBe('aidlc-architecture-reviewer-agent');
  });

  it('clears orphaned rows under since-renamed SKs and rebuilds PHASE#', async () => {
    seedStale();
    await handler({ reseed: true });
    expect(tableStore.has('WF#SYSTEM#aidlc-v2|GROUPING#01#ideation')).toBe(false);
    expect(tableStore.has('WF#SYSTEM#aidlc-v2|PHASE#02#ideation')).toBe(true);
  });

  it('never touches non-SYSTEM (customer fork) partitions', async () => {
    seedStale();
    await handler({ reseed: true });
    expect(tableStore.get('BLOCK#default#STAGE#my-fork|V#latest').name).toBe('My Fork');
    expect(tableStore.has('WF#default#my-wf|META')).toBe(true);
  });

  it('dry-run reseed reports the clear count but deletes nothing', async () => {
    seedStale();
    const before = tableStore.size;
    const result = await handler({ reseed: true, dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.cleared).toBeGreaterThan(0);
    expect(tableStore.size).toBe(before);
  });
});

describe('seed-blocks importRelease mode', () => {
  const profile = AIDLC_COMPATIBILITY_PROFILES[RELEASE_PROFILE];
  const releasePrefix = `aidlc-releases/v1/${profile.upstreamRef}/i${AIDLC_RELEASE_IMPORTER_REVISION}`;

  beforeEach(() => {
    fetchCoreFiles.mockImplementation(async () => releaseFiles());
  });

  it('dry-run summarises the release without writing anything', async () => {
    const result = await handler({ importRelease: true, profile: RELEASE_PROFILE, dryRun: true });

    expect(result).toMatchObject({
      mode: 'importRelease',
      status: 'dry-run',
      dryRun: true,
      profile: RELEASE_PROFILE,
      releaseId: profile.releaseId,
      sourceSha: profile.upstreamRef,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
      manifestKey: `${releasePrefix}/manifest.json`,
      catalogKey: `${releasePrefix}/catalog.json`,
    });
    expect(result.objectCount).toBeGreaterThan(0);
    expect(result.closureDigest).toMatch(/^[0-9a-f]{64}$/);
    expect(s3Store.size).toBe(0);
    expect(tableStore.size).toBe(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('publishes only immutable release + content-addressed keys, never DynamoDB', async () => {
    const result = await handler({ importRelease: true, profile: RELEASE_PROFILE });

    expect(result.status).toBe('published');
    expect(ddbMock.calls()).toHaveLength(0);
    expect(tableStore.size).toBe(0);
    for (const key of s3Store.keys()) {
      expect(key).toMatch(/^(?:aidlc-releases\/v1\/|blocks\/(?:bodies|scripts)\/sha256\/)/);
    }
    expect([...s3Store.keys()].some((key) => key.startsWith('aidlc-runtime/'))).toBe(false);
    expect([...s3Store.keys()].some((key) => key.startsWith('aidlc-catalogs/'))).toBe(false);
    expect(s3Store.has(`${releasePrefix}/manifest.json`)).toBe(true);
    expect(s3Store.has(`${releasePrefix}/catalog.json`)).toBe(true);

    const manifest = JSON.parse(String(s3Store.get(`${releasePrefix}/manifest.json`)));
    expect(manifest.sourceSha).toBe(profile.upstreamRef);
    expect(manifest.closureDigest).toBe(result.closureDigest);
    expect(manifest.objects).toHaveLength(result.objectCount);
  });

  it('re-importing the same release is idempotent', async () => {
    await handler({ importRelease: true, profile: RELEASE_PROFILE });
    const keys = [...s3Store.keys()].toSorted();

    const again = await handler({ importRelease: true, profile: RELEASE_PROFILE });
    expect(again.status).toBe('already-published');
    expect([...s3Store.keys()].toSorted()).toStrictEqual(keys);
  });

  it('rejects an unknown profile, an explicit ref, and a reseed combination', async () => {
    await expect(handler({ importRelease: true, profile: 'main' })).rejects.toThrow(
      /unknown AI-DLC release profile/,
    );
    await expect(handler({ importRelease: true })).rejects.toThrow(
      /unknown AI-DLC release profile/,
    );
    await expect(
      handler({ importRelease: true, profile: '22f5d1b15a064c9ae80046e5b1761d5877e2f69f' }),
    ).rejects.toThrow(/unknown AI-DLC release profile/);
    await expect(
      handler({ importRelease: true, profile: RELEASE_PROFILE, ref: 'b'.repeat(40) }),
    ).rejects.toThrow(/remove "ref"/);
    await expect(
      handler({ importRelease: true, profile: RELEASE_PROFILE, reseed: true }),
    ).rejects.toThrow(/cannot be combined with reseed/);
    expect(s3Store.size).toBe(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });
});

// Custom fork imports (issue #482 follow-up). The property under test: a fork is
// fetched from its own repository at an exact SHA, lands on its own prefix, and
// still cannot touch DynamoDB, aidlc-runtime/, or aidlc-catalogs/.
describe('seed-blocks importRelease custom mode', () => {
  const FORK_SHA = '0123456789abcdef0123456789abcdef01234567';
  const FORK_REPOSITORY = 'acme/aidlc-fork';
  const forkPrefix = `aidlc-releases/v1/custom/${FORK_REPOSITORY}/${FORK_SHA}/i${AIDLC_RELEASE_IMPORTER_REVISION}`;
  const custom = (over = {}) => ({
    repository: FORK_REPOSITORY,
    sha: FORK_SHA,
    baseProfile: RELEASE_PROFILE,
    ...over,
  });

  beforeEach(() => {
    fetchCoreFiles.mockImplementation(async () => releaseFiles());
  });

  it('dry-run summarises the fork as import-only T0 without writing anything', async () => {
    const result = await handler({ importRelease: true, custom: custom(), dryRun: true });

    expect(result).toMatchObject({
      mode: 'importRelease',
      status: 'dry-run',
      dryRun: true,
      profile: `custom:${FORK_REPOSITORY}@${FORK_SHA}`,
      custom: true,
      sourceRepository: FORK_REPOSITORY,
      trustTier: 'T0',
      releaseId: `aidlc-custom:${FORK_REPOSITORY}@${FORK_SHA}`,
      sourceSha: FORK_SHA,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
      manifestKey: `${forkPrefix}/manifest.json`,
      catalogKey: `${forkPrefix}/catalog.json`,
    });
    expect(s3Store.size).toBe(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('fetches the fork repository at the pinned SHA', async () => {
    await handler({ importRelease: true, custom: custom(), dryRun: true });

    expect(fetchCoreFiles).toHaveBeenLastCalledWith(FORK_SHA, {
      owner: 'acme',
      repo: 'aidlc-fork',
    });
  });

  it('publishes only under the custom prefix and never touches DynamoDB', async () => {
    const result = await handler({ importRelease: true, custom: custom() });

    expect(result.status).toBe('published');
    expect(ddbMock.calls()).toHaveLength(0);
    expect(tableStore.size).toBe(0);
    expect(s3Store.has(`${forkPrefix}/manifest.json`)).toBe(true);
    for (const key of s3Store.keys()) {
      expect(key).toMatch(/^(?:aidlc-releases\/v1\/|blocks\/(?:bodies|scripts)\/sha256\/)/);
    }
    expect([...s3Store.keys()].some((key) => key.startsWith('aidlc-runtime/'))).toBe(false);
    expect([...s3Store.keys()].some((key) => key.startsWith('aidlc-catalogs/'))).toBe(false);
    // The official prefix for this SHA must stay empty.
    expect(
      s3Store.has(
        `aidlc-releases/v1/${FORK_SHA}/i${AIDLC_RELEASE_IMPORTER_REVISION}/manifest.json`,
      ),
    ).toBe(false);
  });

  it('is idempotent for the same fork closure', async () => {
    await handler({ importRelease: true, custom: custom() });
    const keys = [...s3Store.keys()].toSorted();

    const again = await handler({ importRelease: true, custom: custom() });
    expect(again.status).toBe('already-published');
    expect([...s3Store.keys()].toSorted()).toStrictEqual(keys);
  });

  it('rejects profile+custom together, a bad custom payload, ref, and reseed', async () => {
    await expect(
      handler({ importRelease: true, profile: RELEASE_PROFILE, custom: custom() }),
    ).rejects.toThrow(/either "profile" or "custom", not both/);
    await expect(handler({ importRelease: true, custom: 'acme/fork' })).rejects.toThrow(
      /"custom" must be an object/,
    );
    await expect(handler({ importRelease: true, custom: [] })).rejects.toThrow(
      /"custom" must be an object/,
    );
    await expect(
      handler({ importRelease: true, custom: custom(), ref: 'b'.repeat(40) }),
    ).rejects.toThrow(/remove "ref"/);
    await expect(handler({ importRelease: true, custom: custom(), reseed: true })).rejects.toThrow(
      /cannot be combined with reseed/,
    );
    expect(s3Store.size).toBe(0);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('rejects a mutable ref, the official repository, and an unknown base dialect', async () => {
    await expect(handler({ importRelease: true, custom: custom({ sha: 'main' }) })).rejects.toThrow(
      /40-hex commit SHA/,
    );
    await expect(
      handler({ importRelease: true, custom: custom({ repository: 'awslabs/aidlc-workflows' }) }),
    ).rejects.toThrow(/official repository/);
    await expect(
      handler({ importRelease: true, custom: custom({ baseProfile: 'nope' }) }),
    ).rejects.toThrow(/base dialect profile must be one of/);
    await expect(
      handler({ importRelease: true, custom: custom({ repository: 'acme/..' }) }),
    ).rejects.toThrow(/not a valid GitHub repository name/);
    expect(s3Store.size).toBe(0);
  });

  it('gives the fork a different release identity than the commit it forked', async () => {
    const fork = await handler({ importRelease: true, custom: custom(), dryRun: true });
    const official = await handler({
      importRelease: true,
      profile: RELEASE_PROFILE,
      dryRun: true,
    });

    expect(fork.releaseId).not.toBe(official.releaseId);
    expect(fork.closureDigest).not.toBe(official.closureDigest);
    expect(
      customProfile({ repository: FORK_REPOSITORY, sha: FORK_SHA, baseProfileId: RELEASE_PROFILE })
        .id,
    ).toBe(fork.profile);
  });
});

// Importer revision bump (issue #482): a re-import after the mappers changed
// lands under a NEW i<revision> prefix beside the closure existing intents pin,
// and an operator payload may assert the revision it expects to publish.
describe('seed-blocks importRelease at the current importer revision', () => {
  const profile = AIDLC_COMPATIBILITY_PROFILES[RELEASE_PROFILE];
  const prefixAt = (revision) => `aidlc-releases/v1/${profile.upstreamRef}/i${revision}`;
  const legacyManifestKey = `${prefixAt(1)}/manifest.json`;
  const legacyCatalogKey = `${prefixAt(1)}/catalog.json`;

  beforeEach(() => {
    fetchCoreFiles.mockImplementation(async () => releaseFiles());
  });

  it('publishes at the asserted current revision with the mapper fingerprint recorded', async () => {
    const result = await handler({
      importRelease: true,
      profile: RELEASE_PROFILE,
      importerRevision: AIDLC_RELEASE_IMPORTER_REVISION,
    });

    expect(AIDLC_RELEASE_IMPORTER_REVISION).toBe(2);
    expect(result).toMatchObject({
      status: 'published',
      importerRevision: 2,
      manifestKey: `${prefixAt(2)}/manifest.json`,
      catalogKey: `${prefixAt(2)}/catalog.json`,
      mapperFingerprint: expect.stringMatching(/^[0-9a-f]{64}$/),
    });
    const manifest = JSON.parse(String(s3Store.get(`${prefixAt(2)}/manifest.json`)));
    expect(manifest.mapperFingerprint).toBe(result.mapperFingerprint);
    expect(ddbMock.calls()).toHaveLength(0);
  });

  it('leaves an already-published revision-1 closure byte-identical and is idempotent at i2', async () => {
    s3Store.set(legacyManifestKey, '{"legacy":"manifest"}\n');
    s3Store.set(legacyCatalogKey, '{"legacy":"catalog"}\n');

    const first = await handler({
      importRelease: true,
      profile: RELEASE_PROFILE,
      importerRevision: 2,
    });
    const keys = [...s3Store.keys()].toSorted();
    const again = await handler({
      importRelease: true,
      profile: RELEASE_PROFILE,
      importerRevision: 2,
    });

    expect(first.status).toBe('published');
    expect(again.status).toBe('already-published');
    expect([...s3Store.keys()].toSorted()).toStrictEqual(keys);
    expect(String(s3Store.get(legacyManifestKey))).toBe('{"legacy":"manifest"}\n');
    expect(String(s3Store.get(legacyCatalogKey))).toBe('{"legacy":"catalog"}\n');
  });

  it('refuses a payload asserting any other importer revision, before fetching anything', async () => {
    fetchCoreFiles.mockClear();
    for (const importerRevision of [1, 3, '2']) {
      await expect(
        handler({ importRelease: true, profile: RELEASE_PROFILE, importerRevision }),
      ).rejects.toThrow(/publishes importer revision 2/);
    }
    expect(fetchCoreFiles).not.toHaveBeenCalled();
    expect(s3Store.size).toBe(0);
  });
});
