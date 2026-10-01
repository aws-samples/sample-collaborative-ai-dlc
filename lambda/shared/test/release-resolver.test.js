// Acceptance tests for release-aware execution.
//
// The property under test: an intent pinned to release A resolves EXACTLY the
// methodology published for release A, even when the SYSTEM DynamoDB rows have
// been reseeded from a different release B. Two real compatibility fixtures are
// used as A and B because they publish the same workflow id at the same numeric
// workflowVersion (aidlc-v2 V#1) with materially different content — which is
// precisely the drift a numeric version cannot distinguish.

import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { DynamoDBDocumentClient, GetCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { customProfile, filesFromCompatibilityFixture } from '../aidlc-compatibility.js';
import { buildReleaseBundle, publishReleaseBundle, releaseManifestKey } from '../aidlc-release.js';
import { sha256 } from '../blocks.js';
import { executionPlanFromMethodologyCatalog } from '../methodology-catalog.js';
import {
  __test,
  loadReleaseClosure,
  methodologyReleasePinFromManifest,
  resolveMethodologyLibrary,
  resolveRuntimeFile,
} from '../release-resolver.js';
import { loadExecutionPlan, loadWorkflowScopes } from '../v2-workflow-plan.js';
import { canonicalJson } from '../workflow-checkpoint.js';

const BUCKET = 'artifacts-test';
const TABLE = 'blocks-test';
const RELEASE_A = 'current-stable';
const RELEASE_B = 'v2.9.0';

const s3Mock = mockClient(S3Client);
const ddbMock = mockClient(DynamoDBDocumentClient);
const s3 = new S3Client({});
const store = new Map();

const noSuchKey = () => {
  const error = new Error('The specified key does not exist.');
  error.name = 'NoSuchKey';
  error.$metadata = { httpStatusCode: 404 };
  return error;
};

const preconditionFailed = () => {
  const error = new Error('At least one of the pre-conditions you specified did not hold');
  error.name = 'PreconditionFailed';
  error.$metadata = { httpStatusCode: 412 };
  return error;
};

const bundleFor = (profileId) =>
  buildReleaseBundle({
    profileId,
    files: filesFromCompatibilityFixture({
      profileId,
      fixture: JSON.parse(
        readFileSync(
          new URL(`./fixtures/aidlc-compatibility/${profileId}.json`, import.meta.url),
          'utf8',
        ),
      ),
    }),
  });

// Building both bundles parses two full fixtures, so do it once for the file.
const bundleA = bundleFor(RELEASE_A);
const bundleB = bundleFor(RELEASE_B);
const pinA = methodologyReleasePinFromManifest(bundleA.manifest);
const pinB = methodologyReleasePinFromManifest(bundleB.manifest);

// SYSTEM rows as a reseed from release B would leave them. Release mode must
// never read any of these; the shapes only need to be plausible enough that a
// leak would visibly change the resolved library (B has 33 stages, A has 32).
const systemBlockRows = Object.fromEntries(
  Object.entries(bundleB.catalog.blocks).map(([type, blocks]) => [
    type,
    blocks.map((block) => ({ ...block, GSI1PK: `TENANT#SYSTEM#${type}` })),
  ]),
);

const systemWorkflowRows = [
  {
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: 'V#1#META',
    version: 1,
    sourceRef: bundleB.manifest.sourceSha,
  },
  ...bundleB.catalog.workflow.placements.map((placement, index) => ({
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: `V#1#PLACEMENT#${placement.stageId}`,
    stageId: placement.stageId,
    stageTenant: placement.stageTenant,
    pinnedVersion: placement.pinnedVersion,
    order: placement.order ?? index,
    scopeMembership: placement.scopeMembership ?? {},
  })),
  ...(bundleB.catalog.workflow.scopeRefs ?? []).map((scopeRef) => ({
    pk: 'WF#SYSTEM#aidlc-v2',
    sk: `V#1#SCOPEREF#${scopeRef.scopeId}`,
    scopeId: scopeRef.scopeId,
  })),
];

const userBlockRows = new Map();
const userWorkflowRows = [];

const installS3Fake = () => {
  s3Mock.reset();
  store.clear();
  s3Mock.on(PutObjectCommand).callsFake((input) => {
    if (input.IfNoneMatch === '*' && store.has(input.Key)) throw preconditionFailed();
    store.set(input.Key, String(input.Body));
    return {};
  });
  s3Mock.on(GetObjectCommand).callsFake((input) => {
    if (!store.has(input.Key)) throw noSuchKey();
    return { Body: { transformToString: async () => store.get(input.Key) } };
  });
};

const installDdbFake = () => {
  ddbMock.reset();
  userBlockRows.clear();
  userWorkflowRows.length = 0;
  ddbMock.on(GetCommand).callsFake((input) => ({
    Item: userBlockRows.get(`${input.Key.pk}|${input.Key.sk}`) ?? null,
  }));
  ddbMock.on(QueryCommand).callsFake((input) => {
    const pk = input.ExpressionAttributeValues?.[':pk'];
    if (input.IndexName === 'GSI1') {
      const [, tenant, type] = String(pk).split('#');
      return { Items: tenant === 'SYSTEM' ? (systemBlockRows[type] ?? []) : [] };
    }
    if (pk === 'WF#SYSTEM#aidlc-v2') return { Items: systemWorkflowRows };
    if (pk === 'WF#default#aidlc-v2') return { Items: userWorkflowRows };
    return { Items: [] };
  });
};

const publishRelease = (bundle) => publishReleaseBundle({ s3, bucket: BUCKET, bundle });

const ddbCallsTouchingSystem = () => [
  ...ddbMock
    .commandCalls(QueryCommand)
    .map((call) => String(call.args[0].input.ExpressionAttributeValues?.[':pk'] ?? ''))
    .filter((pk) => pk.includes('SYSTEM')),
  ...ddbMock
    .commandCalls(GetCommand)
    .map((call) => String(call.args[0].input.Key?.pk ?? ''))
    .filter((pk) => pk.includes('SYSTEM')),
];

const releaseArgs = (pin) => ({ s3, bucket: BUCKET, methodologyRelease: pin });

beforeEach(async () => {
  installS3Fake();
  installDdbFake();
  // The process-wide closure cache is intentionally never invalidated in
  // production (a closure is immutable), so each test starts from cold.
  __test.releaseClosureCache.clear();
  await publishRelease(bundleA);
  await publishRelease(bundleB);
});

describe('loadReleaseClosure', () => {
  it('returns the verified catalog, block index and runtime-file index', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    expect(closure.releaseId).toBe(bundleA.manifest.releaseId);
    expect(closure.sourceSha).toBe(bundleA.manifest.sourceSha);
    expect(closure.closureDigest).toBe(bundleA.manifest.closureDigest);
    expect(canonicalJson(closure.catalog)).toBe(canonicalJson(bundleA.catalog));
    expect(closure.blocksByType.STAGE).toHaveLength(bundleA.catalog.blocks.STAGE.length);
    expect(closure.runtimeFiles.size).toBe(bundleA.manifest.runtimeFiles.length);
    const [firstRuntime] = bundleA.manifest.runtimeFiles;
    expect(closure.runtimeFiles.get(firstRuntime.path)).toEqual({
      sha256: firstRuntime.sha256,
      key: firstRuntime.key,
    });
  });

  it('throws release_not_found for a release that was never published', async () => {
    store.delete(
      releaseManifestKey({
        sha: pinA.sourceSha,
        importerRevision: pinA.importerRevision,
      }),
    );

    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
  });

  it('throws release_closure_mismatch when the stored catalog was tampered with', async () => {
    const tampered = JSON.parse(store.get(pinA.catalogKey));
    tampered.blocks.STAGE[0].leadAgent = 'attacker-agent';
    store.set(pinA.catalogKey, JSON.stringify(tampered, null, 2));

    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_closure_mismatch' });
  });

  it('throws release_closure_mismatch when the catalog object is gone', async () => {
    store.delete(pinA.catalogKey);

    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_closure_mismatch' });
  });

  it.each([
    ['closureDigest', { closureDigest: 'f'.repeat(64) }],
    ['releaseId', { releaseId: 'aidlc:not-this-one' }],
    ['catalogKey', { catalogKey: 'aidlc-releases/v1/elsewhere/catalog.json' }],
  ])('throws release_closure_mismatch when the pinned %s disagrees', async (_field, override) => {
    await expect(
      loadReleaseClosure({ ...releaseArgs({ ...pinA, ...override }), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_closure_mismatch' });
  });

  it('rejects a pin that carries no source sha or closure digest', async () => {
    await expect(
      loadReleaseClosure({ ...releaseArgs({ releaseId: 'aidlc:x' }), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_pin_invalid' });
  });

  it('serves a repeat load from cache without touching S3 again', async () => {
    const cache = new Map();
    await loadReleaseClosure({ ...releaseArgs(pinA), cache });
    const readsAfterFirst = s3Mock.commandCalls(GetObjectCommand).length;

    const second = await loadReleaseClosure({ ...releaseArgs(pinA), cache });

    expect(s3Mock.commandCalls(GetObjectCommand)).toHaveLength(readsAfterFirst);
    expect(second.closureDigest).toBe(pinA.closureDigest);
  });

  it('evicts the oldest closure once the bound is exceeded', async () => {
    const cache = new Map();
    for (let index = 0; index < 9; index += 1) {
      cache.set(`filler-${index}`, { closureDigest: `filler-${index}` });
    }
    await loadReleaseClosure({ ...releaseArgs(pinA), cache });

    expect(cache.size).toBeLessThanOrEqual(8);
    expect(cache.has('filler-0')).toBe(false);
  });
});

describe('resolveMethodologyLibrary against a reseeded SYSTEM catalog', () => {
  it('resolves release A even though every SYSTEM row now holds release B', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const resolved = await resolveMethodologyLibrary({
      closure,
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
    });

    expect(resolved.workflowSource).toBe('release');
    expect(resolved.methodologySourceRefs).toEqual([bundleA.manifest.sourceSha]);
    expect(canonicalJson(resolved.workflow)).toBe(canonicalJson(bundleA.catalog.workflow));
    expect(Object.keys(resolved.library.stagesById).toSorted()).toEqual(
      bundleA.catalog.blocks.STAGE.map((block) => block.blockId).toSorted(),
    );
    expect(ddbCallsTouchingSystem()).toEqual([]);
  });

  it('never reads a SYSTEM workflow row when the release lacks the requested workflow', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    await expect(
      resolveMethodologyLibrary({
        closure,
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'workflow-not-in-release',
        workflowVersion: 7,
      }),
    ).rejects.toMatchObject({ code: 'workflow_not_found' });
    expect(ddbCallsTouchingSystem()).toEqual([]);
  });

  it('reads a user-forked workflow only from its immutable WF#default snapshot', async () => {
    userWorkflowRows.push(
      { pk: 'WF#default#aidlc-v2', sk: 'V#2#META', sourceRef: 'fork-ref' },
      {
        pk: 'WF#default#aidlc-v2',
        sk: 'V#2#PLACEMENT#intent-capture',
        stageId: 'intent-capture',
        stageTenant: 'SYSTEM',
        pinnedVersion: 1,
        order: 0,
        scopeMembership: { feature: 'EXECUTE' },
      },
      { pk: 'WF#default#aidlc-v2', sk: 'V#2#SCOPEREF#feature', scopeId: 'feature' },
    );
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const resolved = await resolveMethodologyLibrary({
      closure,
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 2,
    });

    expect(resolved.workflowSource).toBe('ddb-user-fork');
    expect(resolved.workflow.workflowVersion).toBe(2);
    expect(resolved.workflow.placements.map((placement) => placement.stageId)).toEqual([
      'intent-capture',
    ]);
    // The library is still the release: a fork changes composition, not content.
    expect(resolved.methodologySourceRefs).toEqual([bundleA.manifest.sourceSha]);
    expect(ddbCallsTouchingSystem()).toEqual([]);
  });

  it('overlays an explicitly pinned user block over the release base', async () => {
    const forkedAgent = {
      pk: 'BLOCK#default#AGENT#aidlc-product-agent',
      sk: 'V#4',
      tenantId: 'default',
      blockId: 'aidlc-product-agent',
      id: 'aidlc-product-agent',
      version: 4,
      sourceRef: 'fork-ref',
    };
    userBlockRows.set(`${forkedAgent.pk}|${forkedAgent.sk}`, forkedAgent);
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const resolved = await resolveMethodologyLibrary({
      closure,
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      methodologyPins: {
        AGENT: { 'aidlc-product-agent': { tenantId: 'default', version: 4 } },
      },
    });

    expect(resolved.library.agentsById['aidlc-product-agent']).toEqual(forkedAgent);
    expect(ddbCallsTouchingSystem()).toEqual([]);
  });

  it.each([
    ['a missing version', { tenantId: 'default' }],
    ['a non-integer version', { tenantId: 'default', version: 'latest' }],
    ['a zero version', { tenantId: 'default', version: 0 }],
  ])('rejects a user overlay with %s', async (_label, pin) => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    await expect(
      resolveMethodologyLibrary({
        closure,
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        methodologyPins: { AGENT: { 'aidlc-product-agent': pin } },
      }),
    ).rejects.toMatchObject({ code: 'unpinned_user_block' });
  });

  it('fails closed when a pinned user block version is unavailable', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    await expect(
      resolveMethodologyLibrary({
        closure,
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        methodologyPins: { AGENT: { 'aidlc-product-agent': { tenantId: 'default', version: 9 } } },
      }),
    ).rejects.toMatchObject({ code: 'user_block_missing' });
  });

  it('refuses a user-tenant placement with no pinned version instead of reading V#latest', async () => {
    userWorkflowRows.push(
      { pk: 'WF#default#aidlc-v2', sk: 'V#2#META', sourceRef: 'fork-ref' },
      {
        pk: 'WF#default#aidlc-v2',
        sk: 'V#2#PLACEMENT#custom-stage',
        stageId: 'custom-stage',
        stageTenant: 'default',
        pinnedVersion: null,
        order: 0,
        scopeMembership: { feature: 'EXECUTE' },
      },
    );
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    await expect(
      resolveMethodologyLibrary({
        closure,
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 2,
      }),
    ).rejects.toMatchObject({ code: 'unpinned_user_block' });
    expect(
      ddbMock
        .commandCalls(GetCommand)
        .map((call) => String(call.args[0].input.Key?.sk ?? ''))
        .filter((sk) => sk === 'V#latest'),
    ).toEqual([]);
  });
});

describe('loadExecutionPlan in release mode', () => {
  // The oracle: the plan the existing catalog resolver builds from release A's
  // catalog alone. Release mode must reproduce it byte for byte.
  const planFromReleaseAlone = (variant) =>
    executionPlanFromMethodologyCatalog({
      catalog: bundleA.catalog,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: variant.scope,
      skipStageIds: variant.skipStageIds ?? null,
      composedGrid: variant.composedGrid ?? null,
      strict: variant.strict ?? false,
    });

  const lifecycleVariants = [
    ['start (named scope)', { scope: 'feature' }],
    ['draft (alternate scope)', { scope: 'bugfix' }],
    ['repair (mvp scope)', { scope: 'mvp' }],
    ['rewind (skip overlay)', { scope: 'feature', skipStageIds: ['application-design'] }],
    [
      'recompose (composed grid, strict)',
      {
        scope: 'composed',
        composedGrid: Object.fromEntries(
          bundleA.catalog.workflow.placements.map((placement, index) => [
            placement.stageId,
            index < 4 ? 'EXECUTE' : 'SKIP',
          ]),
        ),
        strict: true,
      },
    ],
  ];

  it.each(lifecycleVariants)(
    'resolves %s identically to release A alone while SYSTEM holds release B',
    async (_label, variant) => {
      const expected = planFromReleaseAlone(variant);

      const actual = await loadExecutionPlan({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: variant.scope,
        skipStageIds: variant.skipStageIds ?? null,
        composedGrid: variant.composedGrid ?? null,
        strict: variant.strict ?? false,
        ...releaseArgs(pinA),
      });

      expect(actual.valid).toBe(expected.valid);
      expect(canonicalJson(actual.plan)).toBe(canonicalJson(expected.plan));
      // The PLAN must match the catalog oracle byte for byte, but the persisted
      // pin set deliberately does NOT: the catalog resolver records every block
      // as (SYSTEM, V#1), and those are exactly the coordinates a SYSTEM reseed
      // rewrites. Release mode persists only real user-tenant overlay pins —
      // here, none — because the release pin already names the exact closure.
      expect(actual.methodologyPins).toEqual({});
      expect(Object.keys(expected.methodologyPins).length).toBeGreaterThan(0);
      expect(actual.methodologySourceRefs).toEqual([bundleA.manifest.sourceSha]);
      expect(ddbCallsTouchingSystem()).toEqual([]);
    },
  );

  it('issues no TENANT#SYSTEM catalog query and no WF#SYSTEM workflow query', async () => {
    await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      ...releaseArgs(pinA),
    });

    const queriedPks = ddbMock
      .commandCalls(QueryCommand)
      .map((call) => String(call.args[0].input.ExpressionAttributeValues?.[':pk'] ?? ''));
    expect(queriedPks.filter((pk) => pk.startsWith('TENANT#SYSTEM#'))).toEqual([]);
    expect(queriedPks.filter((pk) => pk.startsWith('WF#SYSTEM#'))).toEqual([]);
  });

  it('resolves a different plan for release B than for release A', async () => {
    const planA = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      ...releaseArgs(pinA),
    });
    const planB = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      ...releaseArgs(pinB),
    });

    expect(planA.methodologySourceRefs).toEqual([bundleA.manifest.sourceSha]);
    expect(planB.methodologySourceRefs).toEqual([bundleB.manifest.sourceSha]);
    expect(canonicalJson(planA.plan)).not.toBe(canonicalJson(planB.plan));
  });

  it('fails closed with the resolver error code when the release is missing', async () => {
    store.delete(
      releaseManifestKey({ sha: pinA.sourceSha, importerRevision: pinA.importerRevision }),
    );

    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      ...releaseArgs(pinA),
    });

    expect(result.valid).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.errors[0].code).toBe('release_not_found');
    expect(ddbCallsTouchingSystem()).toEqual([]);
  });

  it('offers the release scopes, not the reseeded SYSTEM vocabulary', async () => {
    const scopes = await loadWorkflowScopes({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      ...releaseArgs(pinA),
    });

    expect(scopes.toSorted()).toEqual(
      bundleA.catalog.workflow.scopeRefs.map((scopeRef) => scopeRef.scopeId).toSorted(),
    );
    expect(scopes).not.toContain('express');
    expect(ddbCallsTouchingSystem()).toEqual([]);
  });

  it('offers no scopes when the pinned release cannot be resolved', async () => {
    store.delete(
      releaseManifestKey({ sha: pinA.sourceSha, importerRevision: pinA.importerRevision }),
    );

    await expect(
      loadWorkflowScopes({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        ...releaseArgs(pinA),
      }),
    ).resolves.toEqual([]);
  });
});

describe('resolveRuntimeFile', () => {
  const runtimeEntry = bundleA.manifest.runtimeFiles[0];

  it('returns the digest-verified content-addressed object', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const file = await resolveRuntimeFile({
      s3,
      bucket: BUCKET,
      closure,
      repoPath: runtimeEntry.path,
    });

    expect(file.key).toBe(runtimeEntry.key);
    expect(file.sha256).toBe(runtimeEntry.sha256);
    expect(file.content).toBe(store.get(runtimeEntry.key));
  });

  it('throws runtime_file_missing for a path outside the release', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    await expect(
      resolveRuntimeFile({ s3, bucket: BUCKET, closure, repoPath: 'core/not-in-release.md' }),
    ).rejects.toMatchObject({ code: 'runtime_file_missing' });
  });

  it('throws runtime_file_missing when the object was deleted', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });
    store.delete(runtimeEntry.key);

    await expect(
      resolveRuntimeFile({ s3, bucket: BUCKET, closure, repoPath: runtimeEntry.path }),
    ).rejects.toMatchObject({ code: 'runtime_file_missing' });
  });

  it('throws release_closure_mismatch when the object bytes were tampered with', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });
    store.set(runtimeEntry.key, `${store.get(runtimeEntry.key)}\n// injected`);

    await expect(
      resolveRuntimeFile({ s3, bucket: BUCKET, closure, repoPath: runtimeEntry.path }),
    ).rejects.toMatchObject({ code: 'release_closure_mismatch' });
  });
});

// Defense in depth (issue #482 follow-up). The property under test: runnability
// is re-decided from the manifest at execution time, so a custom/T0 closure
// cannot be started even by a pin that was forged directly onto a META row.
describe('import-only releases never execute', () => {
  const customBundle = () =>
    buildReleaseBundle({
      profile: customProfile({
        repository: 'acme/aidlc-fork',
        sha: '0123456789abcdef0123456789abcdef01234567',
        baseProfileId: RELEASE_A,
      }),
      files: filesFromCompatibilityFixture({
        profileId: RELEASE_A,
        fixture: JSON.parse(
          readFileSync(
            new URL(`./fixtures/aidlc-compatibility/${RELEASE_A}.json`, import.meta.url),
            'utf8',
          ),
        ),
      }),
    });

  it('throws release_not_runnable for a custom closure, even under a forged official key', async () => {
    const bundle = customBundle();
    const pin = {
      releaseId: bundle.manifest.releaseId,
      sourceSha: bundle.manifest.sourceSha,
      importerRevision: bundle.manifest.importerRevision,
      closureDigest: bundle.manifest.closureDigest,
      catalogKey: bundle.manifest.catalog.key,
    };

    // A hand-forged pin plus the manifest bytes copied onto the OFFICIAL prefix
    // is the strongest attack available to somebody with table/bucket write
    // access: everything the pin claims matches the manifest.
    store.set(
      releaseManifestKey({
        sha: bundle.manifest.sourceSha,
        importerRevision: bundle.manifest.importerRevision,
      }),
      `${JSON.stringify(bundle.manifest, null, 2)}\n`,
    );

    await expect(
      loadReleaseClosure({ ...releaseArgs(pin), cache: new Map() }),
    ).rejects.toMatchObject({
      code: 'release_not_runnable',
      details: expect.objectContaining({
        custom: true,
        trustTier: 'T0',
        sourceRepository: 'acme/aidlc-fork',
      }),
    });
  });

  it('throws release_not_runnable for any T0 manifest, custom flag or not', async () => {
    // Re-digested so the manifest is internally consistent: the point is that
    // T0 alone is fatal, not that tampering happens to break the digest.
    const { closureDigest: _digest, ...base } = { ...bundleA.manifest, trustTier: 'T0' };
    const manifest = { ...base, closureDigest: sha256(canonicalJson(base)) };
    store.set(
      releaseManifestKey({
        sha: manifest.sourceSha,
        importerRevision: manifest.importerRevision,
      }),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );

    await expect(
      loadReleaseClosure({
        ...releaseArgs({ ...pinA, closureDigest: manifest.closureDigest }),
        cache: new Map(),
      }),
    ).rejects.toMatchObject({ code: 'release_not_runnable' });
  });

  it('still resolves a trusted official closure', async () => {
    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).resolves.toMatchObject({ releaseId: bundleA.manifest.releaseId });
  });
});

// ── Closure digests, cache keys, and workflow scope loading ──

describe('closure objectDigests', () => {
  it('indexes every manifest object by its S3 key', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    expect(closure.objectDigests).toBeInstanceOf(Map);
    expect(closure.objectDigests.size).toBe(bundleA.manifest.objects.length);
    for (const object of bundleA.manifest.objects) {
      expect(closure.objectDigests.get(object.key)).toBe(object.sha256);
    }
  });

  it('carries the digest of a block body the runtime will load lazily', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });
    const [stage] = closure.blocksByType.STAGE;

    // The lazy loader only has the bodyRef's s3Key, so that key MUST be the
    // lookup that yields the expected digest — otherwise release-mode integrity
    // verification has nothing to compare against.
    expect(closure.objectDigests.get(stage.bodyRef.s3Key)).toMatch(/^[0-9a-f]{64}$/);
  });

  it('does not leak digests from a different release', async () => {
    const closureA = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });
    const bOnlyKeys = bundleB.manifest.objects
      .map((object) => object.key)
      .filter((key) => !closureA.objectDigests.has(key));

    expect(bOnlyKeys.length).toBeGreaterThan(0);
  });
});

describe('closure cache key and eviction', () => {
  it('keys on sourceSha and importerRevision, not just releaseId + digest', () => {
    const base = __test.closureCacheKey(pinA);

    expect(
      __test.closureCacheKey({ ...pinA, importerRevision: pinA.importerRevision + 1 }),
    ).not.toBe(base);
    expect(__test.closureCacheKey({ ...pinA, sourceSha: 'f'.repeat(40) })).not.toBe(base);
    // An absent importerRevision must normalize to the current one rather than
    // producing a third, distinct key for the same bytes.
    const { importerRevision: _dropped, ...withoutRevision } = pinA;
    expect(__test.closureCacheKey(withoutRevision)).toBe(base);
  });

  it('re-reads the closure when only the importer revision differs', async () => {
    const cache = new Map();
    await loadReleaseClosure({ ...releaseArgs(pinA), cache });
    const reads = s3Mock.commandCalls(GetObjectCommand).length;

    // Same releaseId and closureDigest, different importer revision: the bytes
    // live under a different prefix, so the cache must miss.
    await expect(
      loadReleaseClosure({
        ...releaseArgs({ ...pinA, importerRevision: pinA.importerRevision + 1 }),
        cache,
      }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
    expect(s3Mock.commandCalls(GetObjectCommand).length).toBeGreaterThan(reads);
  });

  it('evicts least-RECENTLY-used, not least-recently-inserted', async () => {
    const cache = new Map();
    await loadReleaseClosure({ ...releaseArgs(pinA), cache });
    await loadReleaseClosure({ ...releaseArgs(pinB), cache });
    // Touch A so it becomes the most recent entry.
    await loadReleaseClosure({ ...releaseArgs(pinA), cache });
    // Fill past the bound; a pure insertion-order map would have dropped A.
    for (let index = 0; index < __test.RELEASE_CLOSURE_CACHE_LIMIT; index += 1) {
      cache.set(`filler-${index}`, { releaseId: `filler-${index}` });
      while (cache.size > __test.RELEASE_CLOSURE_CACHE_LIMIT) {
        cache.delete(cache.keys().next().value);
      }
    }
    expect(cache.has(__test.closureCacheKey(pinB))).toBe(false);
  });

  it('refuses a catalog whose declared length exceeds the JSON cap', async () => {
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      return {
        // Reported before the stream is drained, so an oversized object is
        // rejected without ever being buffered into the Lambda heap.
        ContentLength:
          input.Key === bundleA.manifest.catalog.key
            ? __test.RELEASE_JSON_MAX_BYTES + 1
            : undefined,
        Body: { transformToString: async () => store.get(input.Key) },
      };
    });

    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_closure_too_large' });
  });
});

describe('loadWorkflowScopes separates permanent from transient failures', () => {
  it('returns no scopes when the release genuinely does not resolve', async () => {
    store.delete(
      releaseManifestKey({ sha: pinA.sourceSha, importerRevision: pinA.importerRevision }),
    );

    await expect(
      loadWorkflowScopes({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        ...releaseArgs(pinA),
      }),
    ).resolves.toEqual([]);
  });

  it('propagates a transient S3 fault instead of reporting an empty vocabulary', async () => {
    // Swallowing this would reject a perfectly valid scope on a retryable blip.
    const throttled = new Error('SlowDown');
    throttled.name = 'SlowDown';
    throttled.$metadata = { httpStatusCode: 503 };
    s3Mock.on(GetObjectCommand).callsFake(() => {
      throw throttled;
    });

    await expect(
      loadWorkflowScopes({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        ...releaseArgs(pinA),
      }),
    ).rejects.toMatchObject({ name: 'SlowDown' });
  });

  it('propagates a transient fault out of loadExecutionPlan rather than returning valid:false', async () => {
    const throttled = new Error('SlowDown');
    throttled.name = 'SlowDown';
    throttled.$metadata = { httpStatusCode: 503 };
    s3Mock.on(GetObjectCommand).callsFake(() => {
      throw throttled;
    });

    await expect(
      loadExecutionPlan({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        scope: 'feature',
        ...releaseArgs(pinA),
      }),
    ).rejects.toMatchObject({ name: 'SlowDown' });
  });

  it('still reports an unresolvable release as an invalid plan', async () => {
    store.delete(
      releaseManifestKey({ sha: pinA.sourceSha, importerRevision: pinA.importerRevision }),
    );

    const result = await loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      ...releaseArgs(pinA),
    });

    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('release_not_found');
  });
});

// ── Fork lookup is tenant-scoped ──

describe('loadUserForkWorkflow is tenant-parameterized', () => {
  const forkRows = (pk) => [
    { pk, sk: 'V#2#META', sourceRef: 'fork-ref' },
    {
      pk,
      sk: 'V#2#PLACEMENT#aidlc-requirements',
      stageId: 'aidlc-requirements',
      stageTenant: 'SYSTEM',
      pinnedVersion: null,
      order: 0,
      scopeMembership: { feature: 'EXECUTE' },
    },
  ];

  const queriedWorkflowPks = () =>
    ddbMock
      .commandCalls(QueryCommand)
      .map((call) => String(call.args[0].input.ExpressionAttributeValues?.[':pk'] ?? ''))
      .filter((pk) => pk.startsWith('WF#'));

  it('defaults to the `default` tenant so existing callers are unchanged', async () => {
    userWorkflowRows.push(...forkRows('WF#default#aidlc-v2'));
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const resolved = await resolveMethodologyLibrary({
      closure,
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 2,
    });

    expect(resolved.workflowSource).toBe('ddb-user-fork');
    expect(queriedWorkflowPks()).toEqual(['WF#default#aidlc-v2']);
  });

  it('uses the release workflow when the mutable version is newer and no fork snapshot exists', async () => {
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const resolved = await resolveMethodologyLibrary({
      closure,
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 4,
    });

    expect(resolved.workflowSource).toBe('release');
    expect(resolved.workflow.workflowVersion).toBe(1);
    expect(canonicalJson(resolved.workflow)).toBe(canonicalJson(bundleA.catalog.workflow));
    expect(queriedWorkflowPks()).toEqual(['WF#default#aidlc-v2']);
  });

  it('reads the caller tenant partition when one is threaded through', async () => {
    // An explicit tenant must change WHICH partition is read, not just be accepted
    // and ignored: the `default` rows are present and must NOT be the answer.
    userWorkflowRows.push(...forkRows('WF#default#aidlc-v2'));
    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    const resolved = await resolveMethodologyLibrary({
      closure,
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 2,
      tenant: 'other-tenant',
    });

    expect(resolved.workflowSource).toBe('release');
    expect(resolved.workflow.workflowVersion).toBe(1);
    expect(queriedWorkflowPks()).toEqual(['WF#other-tenant#aidlc-v2']);
  });
});

// ── The size cap does not rely on ContentLength ──

describe('the release JSON cap bounds a stream that does not declare its size', () => {
  const chunkedBody = (text) => ({
    async *[Symbol.asyncIterator]() {
      const buffer = Buffer.from(text, 'utf8');
      for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
        yield buffer.subarray(offset, offset + 64 * 1024);
      }
    },
  });

  it('refuses an oversized catalog served with NO ContentLength', async () => {
    const oversized = JSON.stringify({ pad: 'x'.repeat(__test.RELEASE_JSON_MAX_BYTES + 1) });
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      if (input.Key === bundleA.manifest.catalog.key) {
        // No ContentLength at all — the pre-flight check sees 0 and passes, so only
        // the byte counter inside the reader can stop this.
        return { Body: chunkedBody(oversized) };
      }
      return { Body: { transformToString: async () => store.get(input.Key) } };
    });

    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_closure_too_large' });
  });

  it('refuses an oversized catalog whose ContentLength UNDERSTATES its size', async () => {
    const oversized = JSON.stringify({ pad: 'x'.repeat(__test.RELEASE_JSON_MAX_BYTES + 1) });
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      if (input.Key === bundleA.manifest.catalog.key) {
        return { ContentLength: 10, Body: chunkedBody(oversized) };
      }
      return { Body: { transformToString: async () => store.get(input.Key) } };
    });

    await expect(
      loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() }),
    ).rejects.toMatchObject({ code: 'release_closure_too_large' });
  });

  it('still reads a within-cap catalog delivered as an undeclared stream', async () => {
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      if (input.Key === bundleA.manifest.catalog.key) {
        return { Body: chunkedBody(store.get(input.Key)) };
      }
      return { Body: { transformToString: async () => store.get(input.Key) } };
    });

    const closure = await loadReleaseClosure({ ...releaseArgs(pinA), cache: new Map() });

    expect(canonicalJson(closure.catalog)).toBe(canonicalJson(bundleA.catalog));
  });
});

// ── Manifest-level errors are permanent ──
//
// `loadReleaseClosure` reads the manifest through aidlc-release.js, which raises
// `AidlcReleaseError` rather than `ReleaseResolverError`. Those codes describe
// content the platform refuses, so they must classify as an invalid plan (typed
// 4xx) and not escape as a transient 5xx a caller would retry forever.

describe('AidlcReleaseError manifest codes classify as permanent', () => {
  const manifestKeyA = () =>
    releaseManifestKey({ sha: pinA.sourceSha, importerRevision: pinA.importerRevision });

  const planForA = () =>
    loadExecutionPlan({
      ddb: ddbMock,
      tableName: TABLE,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'feature',
      ...releaseArgs(pinA),
    });

  it('reports a structurally invalid manifest as an invalid plan', async () => {
    store.set(
      manifestKeyA(),
      JSON.stringify({ ...bundleA.manifest, closureDigest: 'a'.repeat(64) }),
    );

    const result = await planForA();

    expect(result.valid).toBe(false);
    expect(result.plan).toBeNull();
    expect(result.errors[0].code).toBe('release_manifest_invalid');
  });

  it('reports an oversized manifest as an invalid plan', async () => {
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (!store.has(input.Key)) throw noSuchKey();
      return {
        ContentLength: input.Key === manifestKeyA() ? 20 * 1024 * 1024 + 1 : undefined,
        Body: { transformToString: async () => store.get(input.Key) },
      };
    });

    const result = await planForA();

    expect(result.valid).toBe(false);
    expect(result.errors[0].code).toBe('release_manifest_too_large');
  });

  it('reports no scopes rather than throwing for an invalid manifest', async () => {
    store.set(
      manifestKeyA(),
      JSON.stringify({ ...bundleA.manifest, closureDigest: 'a'.repeat(64) }),
    );

    await expect(
      loadWorkflowScopes({
        ddb: ddbMock,
        tableName: TABLE,
        workflowId: 'aidlc-v2',
        workflowVersion: 1,
        ...releaseArgs(pinA),
      }),
    ).resolves.toEqual([]);
  });

  it('still lets a genuinely transient S3 fault escape as a throw', async () => {
    const slowDown = Object.assign(new Error('Please reduce your request rate'), {
      name: 'SlowDown',
      $metadata: { httpStatusCode: 503 },
    });
    s3Mock.on(GetObjectCommand).callsFake((input) => {
      if (input.Key === manifestKeyA()) throw slowDown;
      if (!store.has(input.Key)) throw noSuchKey();
      return { Body: { transformToString: async () => store.get(input.Key) } };
    });

    await expect(planForA()).rejects.toMatchObject({ name: 'SlowDown' });
  });
});
