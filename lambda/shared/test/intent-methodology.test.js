import { describe, expect, it, vi } from 'vitest';
import { createIntentMethodologyLoader, intentMethodologyOptions } from '../intent-methodology.js';

describe('createIntentMethodologyLoader', () => {
  it('keeps workflow and methodology identity from metadata and resolves release options per call', async () => {
    const ddb = {};
    const s3 = {};
    let tableName = 'blocks-v1';
    let bucket = 'artifacts-v1';
    const loadPlan = vi.fn(async () => ({ valid: true }));
    const loadScopes = vi.fn(async () => ['feature']);
    const loader = createIntentMethodologyLoader({
      ddb,
      tableName: () => tableName,
      s3,
      bucket: () => bucket,
      loadPlan,
      loadScopes,
    });
    const meta = {
      workflowId: 'pinned-workflow',
      workflowVersion: 7,
      methodologyPins: { AGENT: { agent: { tenantId: 'tenant-a', version: 3 } } },
      methodologyRelease: { releaseId: 'release-a', sourceSha: 'a'.repeat(40) },
    };
    const overrides = {
      workflowId: 'other-workflow',
      workflowVersion: 99,
      methodologyPins: { AGENT: {} },
      methodologyRelease: null,
      scope: 'feature',
    };

    await loader.loadPlan(meta, overrides);
    expect(loadPlan).toHaveBeenLastCalledWith({
      ddb,
      tableName: 'blocks-v1',
      scope: 'feature',
      methodologyPins: meta.methodologyPins,
      methodologyRelease: meta.methodologyRelease,
      s3,
      bucket: 'artifacts-v1',
      workflowId: meta.workflowId,
      workflowVersion: meta.workflowVersion,
    });

    tableName = 'blocks-v2';
    bucket = 'artifacts-v2';
    await loader.loadScopes({
      ...meta,
      workflowId: 'scope-workflow',
      workflowVersion: 8,
    });
    expect(loadScopes).toHaveBeenLastCalledWith({
      ddb,
      tableName: 'blocks-v2',
      methodologyPins: meta.methodologyPins,
      methodologyRelease: meta.methodologyRelease,
      s3,
      bucket: 'artifacts-v2',
      workflowId: 'scope-workflow',
      workflowVersion: 8,
    });
  });

  it('preserves the unpinned loader behavior', async () => {
    const ddb = {};
    const loadPlan = vi.fn(async () => ({ valid: true }));
    const loadScopes = vi.fn(async () => []);
    const loader = createIntentMethodologyLoader({
      ddb,
      tableName: 'blocks',
      s3: {},
      bucket: 'artifacts',
      loadPlan,
      loadScopes,
    });
    const meta = {
      workflowId: 'workflow',
      workflowVersion: 2,
      scope: 'feature',
      skipStageIds: [],
      composedGrid: null,
    };

    await loader.loadPlan(meta);
    expect(loadPlan).toHaveBeenLastCalledWith({
      ddb,
      tableName: 'blocks',
      scope: 'feature',
      workflowId: 'workflow',
      workflowVersion: 2,
    });
    await loader.loadScopes(meta);
    expect(loadScopes).toHaveBeenLastCalledWith({
      ddb,
      tableName: 'blocks',
      workflowId: 'workflow',
      workflowVersion: 2,
    });
  });

  it('lets projection overrides replace or clear snapshot overlays', async () => {
    const loadPlan = vi.fn(async () => ({ valid: true }));
    const loader = createIntentMethodologyLoader({
      ddb: {},
      tableName: 'blocks',
      loadPlan,
    });

    await loader.loadPlan(
      {
        workflowId: 'workflow',
        workflowVersion: 2,
        scope: 'old-scope',
        skipStageIds: ['old-stage'],
        composedGrid: { 'old-stage': 'SKIP' },
        strict: true,
      },
      {
        scope: 'new-scope',
        skipStageIds: [],
        composedGrid: null,
        strict: false,
      },
    );

    expect(loadPlan).toHaveBeenLastCalledWith({
      ddb: {},
      tableName: 'blocks',
      scope: 'new-scope',
      skipStageIds: [],
      composedGrid: null,
      strict: false,
      workflowId: 'workflow',
      workflowVersion: 2,
    });
  });

  it('ignores methodology overrides for an unpinned intent', async () => {
    const loadPlan = vi.fn(async () => ({ valid: true }));
    const loadScopes = vi.fn(async () => []);
    const loader = createIntentMethodologyLoader({
      ddb: {},
      tableName: 'blocks',
      s3: {},
      bucket: 'artifacts',
      loadPlan,
      loadScopes,
    });
    const meta = { workflowId: 'workflow', workflowVersion: 2 };

    await loader.loadPlan(meta, {
      methodologyRelease: { releaseId: 'release-a', sourceSha: 'a'.repeat(40) },
      methodologyPins: { AGENT: { agent: { tenantId: 'tenant-a', version: 3 } } },
      s3: {},
      bucket: 'other-bucket',
    });

    expect(loadPlan).toHaveBeenLastCalledWith({
      ddb: {},
      tableName: 'blocks',
      workflowId: 'workflow',
      workflowVersion: 2,
    });
  });
});

describe('intentMethodologyOptions', () => {
  it('adds release loading options only for an intent with a release pin', () => {
    const s3 = {};
    const bucket = vi.fn(() => 'release-bucket');
    const pin = { releaseId: 'release-a' };

    expect(intentMethodologyOptions({ methodologyRelease: pin }, { s3, bucket })).toEqual({
      methodologyRelease: pin,
      s3,
      bucket: 'release-bucket',
    });
    expect(bucket).toHaveBeenCalledOnce();
    expect(intentMethodologyOptions({}, { s3, bucket })).toEqual({});
    expect(bucket).toHaveBeenCalledOnce();
  });
});
