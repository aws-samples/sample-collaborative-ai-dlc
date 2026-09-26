// Release-aware AgentCore block loading.
//
// The property under test: a stage dispatched for an intent pinned to release A
// resolves EXACTLY release A's methodology and conductor, even though the SYSTEM
// DynamoDB rows and the mutable aidlc-runtime/ prefix both hold release B.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  listReleaseBlocks,
  loadBlockBody,
  loadBlockScript,
  loadConductor,
  loadLibrary,
} from '../block-loader.js';
import {
  BUCKET,
  bundleA,
  bundleB,
  conductorEntry,
  CONDUCTOR_REPO_PATH,
  installReleaseFixtures,
  pinA,
  pinB,
  WORKFLOW_ID,
} from './helpers/release-fixture.js';

describe('loadLibrary — release mode', () => {
  let fixtures;

  beforeEach(async () => {
    fixtures = await installReleaseFixtures();
  });

  afterEach(() => {
    fixtures.s3Mock.restore();
    fixtures.ddbMock.restore();
    delete process.env.ARTIFACTS_BUCKET;
    delete process.env.BLOCKS_TABLE;
  });

  it('resolves release A while every SYSTEM row holds release B', async () => {
    const { workflow, library } = await loadLibrary({
      workflowId: WORKFLOW_ID,
      workflowVersion: 1,
      methodologyRelease: pinA,
    });

    expect(workflow.sourceRef).toBe(bundleA.manifest.sourceSha);
    expect(Object.keys(library.stagesById).toSorted()).toEqual(
      bundleA.catalog.blocks.STAGE.map((block) => block.blockId).toSorted(),
    );
    // B publishes one more stage at the same workflowVersion — the tell of a leak.
    expect(Object.keys(library.stagesById)).toHaveLength(bundleA.catalog.blocks.STAGE.length);
    expect(Object.keys(library.stagesById).length).not.toBe(bundleB.catalog.blocks.STAGE.length);
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });

  it('issues no TENANT#SYSTEM catalog query and no WF#SYSTEM workflow query', async () => {
    await loadLibrary({
      workflowId: WORKFLOW_ID,
      workflowVersion: 1,
      methodologyRelease: pinA,
    });

    const queried = fixtures.pksTouchingSystem();
    expect(queried.filter((pk) => pk.startsWith('TENANT#SYSTEM#'))).toEqual([]);
    expect(queried.filter((pk) => pk.startsWith('WF#SYSTEM#'))).toEqual([]);
  });

  it('resolves a different library for release B than for release A', async () => {
    const a = await loadLibrary({
      workflowId: WORKFLOW_ID,
      workflowVersion: 1,
      methodologyRelease: pinA,
    });
    const b = await loadLibrary({
      workflowId: WORKFLOW_ID,
      workflowVersion: 1,
      methodologyRelease: pinB,
    });

    expect(a.workflow.sourceRef).toBe(bundleA.manifest.sourceSha);
    expect(b.workflow.sourceRef).toBe(bundleB.manifest.sourceSha);
    expect(Object.keys(a.library.stagesById).length).not.toBe(
      Object.keys(b.library.stagesById).length,
    );
  });

  it('accepts an aidlcRepoRef that matches the release source sha', async () => {
    await expect(
      loadLibrary({
        workflowId: WORKFLOW_ID,
        workflowVersion: 1,
        aidlcRepoRef: bundleA.manifest.sourceSha,
        methodologyRelease: pinA,
      }),
    ).resolves.toMatchObject({ workflow: { sourceRef: bundleA.manifest.sourceSha } });
  });

  it('rejects an aidlcRepoRef that disagrees with the pinned release', async () => {
    await expect(
      loadLibrary({
        workflowId: WORKFLOW_ID,
        workflowVersion: 1,
        aidlcRepoRef: bundleB.manifest.sourceSha,
        methodologyRelease: pinA,
      }),
    ).rejects.toThrow(/does not match AI-DLC repository ref/);
  });

  it('fails closed with the resolver code instead of falling back to the SYSTEM rows', async () => {
    fixtures.store.delete(pinA.manifestKey);

    await expect(
      loadLibrary({
        workflowId: WORKFLOW_ID,
        workflowVersion: 1,
        methodologyRelease: pinA,
      }),
    ).rejects.toMatchObject({ code: 'release_not_found' });
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });

  it('fails closed when the published catalog was tampered with', async () => {
    const tampered = JSON.parse(fixtures.store.get(pinA.catalogKey));
    tampered.blocks.STAGE[0].leadAgent = 'attacker-agent';
    fixtures.store.set(pinA.catalogKey, JSON.stringify(tampered, null, 2));

    await expect(
      loadLibrary({
        workflowId: WORKFLOW_ID,
        workflowVersion: 1,
        methodologyRelease: pinA,
      }),
    ).rejects.toMatchObject({ code: 'release_closure_mismatch' });
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });

  it('stamps fromRelease so the plan resolver can gate authored policy', async () => {
    const { library } = await loadLibrary({
      workflowId: WORKFLOW_ID,
      workflowVersion: 1,
      methodologyRelease: pinA,
    });

    expect(library.fromRelease).toBe(true);
  });

  it('fails closed when the requested workflow is in neither release nor fork', async () => {
    await expect(
      loadLibrary({
        workflowId: 'workflow-not-in-release',
        workflowVersion: 9,
        methodologyRelease: pinA,
      }),
    ).rejects.toMatchObject({ code: 'workflow_not_found' });
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });
});

describe('listReleaseBlocks', () => {
  let fixtures;

  beforeEach(async () => {
    fixtures = await installReleaseFixtures();
  });

  afterEach(() => {
    fixtures.s3Mock.restore();
    fixtures.ddbMock.restore();
    delete process.env.ARTIFACTS_BUCKET;
    delete process.env.BLOCKS_TABLE;
  });

  it("returns the release's SCOPE blocks, not the reseeded SYSTEM vocabulary", async () => {
    const scopes = await listReleaseBlocks('SCOPE', pinA);

    expect(scopes.map((scope) => scope.blockId).toSorted()).toEqual(
      bundleA.catalog.blocks.SCOPE.map((scope) => scope.blockId).toSorted(),
    );
    expect(scopes).toHaveLength(bundleA.catalog.blocks.SCOPE.length);
    expect(scopes.length).not.toBe(bundleB.catalog.blocks.SCOPE.length);
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });

  it('overlays the scope version pinned on the intent', async () => {
    const baseScope = bundleA.catalog.blocks.SCOPE[0];
    const scopeId = baseScope.id ?? baseScope.blockId;
    const pk = `BLOCK#default#SCOPE#${scopeId}`;
    const scopeOverride = {
      ...baseScope,
      pk,
      sk: 'V#7',
      tenantId: 'default',
      version: 7,
    };
    fixtures.userBlockRows.set(`${pk}|V#7`, scopeOverride);

    const scopes = await listReleaseBlocks('SCOPE', pinA, {
      SCOPE: { [scopeId]: { tenantId: 'default', version: 7 } },
    });

    expect(scopes.find((scope) => (scope.id ?? scope.blockId) === scopeId)).toEqual(scopeOverride);
    expect(fixtures.pksTouchingSystem()).toEqual([]);
  });

  it('fails closed when the release cannot be resolved', async () => {
    fixtures.store.delete(pinA.manifestKey);

    await expect(listReleaseBlocks('SCOPE', pinA)).rejects.toMatchObject({
      code: 'release_not_found',
    });
  });
});

describe('loadConductor', () => {
  let fixtures;
  const runtimeKeyFor = (sha) => `aidlc-runtime/${sha}/${CONDUCTOR_REPO_PATH}`;

  beforeEach(async () => {
    fixtures = await installReleaseFixtures();
  });

  afterEach(() => {
    fixtures.s3Mock.restore();
    fixtures.ddbMock.restore();
    delete process.env.ARTIFACTS_BUCKET;
    delete process.env.BLOCKS_TABLE;
  });

  it("reads the release's own object, ignoring a divergent aidlc-runtime snapshot", async () => {
    const entry = conductorEntry(bundleA);
    fixtures.store.set(runtimeKeyFor(bundleB.manifest.sourceSha), '# hijacked conductor');

    const content = await loadConductor(bundleB.manifest.sourceSha, {
      methodologyRelease: pinA,
    });

    expect(content).toBe(fixtures.store.get(entry.key));
    expect(content).not.toBe('# hijacked conductor');
  });

  it('throws instead of degrading to an empty conductor when the object is tampered with', async () => {
    const entry = conductorEntry(bundleA);
    fixtures.store.set(entry.key, `${fixtures.store.get(entry.key)}\n// injected`);

    await expect(loadConductor(null, { methodologyRelease: pinA })).rejects.toMatchObject({
      code: 'release_closure_mismatch',
    });
  });

  it('throws when the release carries no conductor object', async () => {
    fixtures.store.delete(conductorEntry(bundleA).key);

    await expect(loadConductor(null, { methodologyRelease: pinA })).rejects.toMatchObject({
      code: 'runtime_file_missing',
    });
  });

  it('keeps reading the mutable runtime prefix when no release is pinned', async () => {
    fixtures.store.set(runtimeKeyFor('legacy-ref'), '# legacy conductor');

    await expect(loadConductor('legacy-ref')).resolves.toBe('# legacy conductor');
    await expect(loadConductor(null)).resolves.toBe('');
  });

  it('resolves against the configured artifacts bucket', async () => {
    await loadConductor(null, { methodologyRelease: pinA });

    for (const call of fixtures.s3Mock.calls()) {
      if (call.args[0].input?.Bucket) expect(call.args[0].input.Bucket).toBe(BUCKET);
    }
  });
});

// A stage body, persona, or sensor script is the complete instruction set or
// executable for a run. Release mode verifies its bytes against the closure and
// throws on a mismatch rather than turning a tampered object into an empty prompt.
describe('loadBlockBody / loadBlockScript — release-mode integrity', () => {
  let fixtures;

  const stageBlock = () => bundleA.catalog.blocks.STAGE[0];
  const sensorBlock = () => bundleA.catalog.blocks.SENSOR.find((block) => block.scriptRef);

  beforeEach(async () => {
    fixtures = await installReleaseFixtures();
  });

  afterEach(() => {
    fixtures.s3Mock.restore();
    fixtures.ddbMock.restore();
    delete process.env.ARTIFACTS_BUCKET;
    delete process.env.BLOCKS_TABLE;
  });

  it("returns the release's own verified bytes for a body and a script", async () => {
    const stage = stageBlock();
    const sensor = sensorBlock();

    await expect(loadBlockBody(stage, { methodologyRelease: pinA })).resolves.toBe(
      fixtures.store.get(stage.bodyRef.s3Key),
    );
    await expect(loadBlockScript(sensor, { methodologyRelease: pinA })).resolves.toBe(
      fixtures.store.get(sensor.scriptRef.s3Key),
    );
  });

  it('reads pinned user override bodies outside the release object index', async () => {
    const key = 'blocks/bodies/sha256/user-agent-v7';
    fixtures.store.set(key, '# User agent V7');

    await expect(
      loadBlockBody({ tenantId: 'default', bodyRef: { s3Key: key } }, { methodologyRelease: pinA }),
    ).resolves.toBe('# User agent V7');
  });

  it('throws instead of returning tampered body bytes', async () => {
    const stage = stageBlock();
    fixtures.store.set(stage.bodyRef.s3Key, '# injected stage instructions');

    await expect(loadBlockBody(stage, { methodologyRelease: pinA })).rejects.toMatchObject({
      code: 'release_closure_mismatch',
    });
  });

  it('throws instead of returning a tampered sensor script', async () => {
    const sensor = sensorBlock();
    fixtures.store.set(sensor.scriptRef.s3Key, 'process.exit(0);');

    await expect(loadBlockScript(sensor, { methodologyRelease: pinA })).rejects.toMatchObject({
      code: 'release_closure_mismatch',
    });
  });

  it('throws rather than degrading to an empty body when the object is gone', async () => {
    const stage = stageBlock();
    fixtures.store.delete(stage.bodyRef.s3Key);

    await expect(loadBlockBody(stage, { methodologyRelease: pinA })).rejects.toThrow();
  });

  it('refuses a block whose ref carries no digest and which the closure does not list', async () => {
    await expect(
      loadBlockBody(
        { bodyRef: { s3Key: 'blocks/bodies/sha256/unlisted' } },
        { methodologyRelease: pinA },
      ),
    ).rejects.toMatchObject({ code: 'release_object_unverifiable' });
  });

  // The closure's `objectDigests` (from manifest.objects) is authoritative, so a
  // catalog ref that disagrees with it is an internally inconsistent closure and
  // is refused BEFORE the object is fetched.
  it('refuses a catalog ref whose digest disagrees with the published object list', async () => {
    const stage = stageBlock();
    const forged = {
      ...stage,
      bodyRef: { ...stage.bodyRef, sha256: '0'.repeat(64) },
    };

    await expect(loadBlockBody(forged, { methodologyRelease: pinA })).rejects.toMatchObject({
      code: 'release_closure_mismatch',
    });
  });

  it("returns '' for a block that genuinely carries no body or script", async () => {
    await expect(loadBlockBody({}, { methodologyRelease: pinA })).resolves.toBe('');
    await expect(loadBlockScript({}, { methodologyRelease: pinA })).resolves.toBe('');
  });

  it('leaves the legacy path unverified and unchanged', async () => {
    const stage = stageBlock();
    fixtures.store.set(stage.bodyRef.s3Key, '# locally edited body');

    await expect(loadBlockBody(stage)).resolves.toBe('# locally edited body');
  });
});
