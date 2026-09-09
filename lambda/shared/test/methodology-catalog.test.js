import { beforeEach, describe, expect, it, vi } from 'vitest';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { mockClient } from 'aws-sdk-client-mock';
import { buildFromFiles } from '../block-mappers.js';
import {
  buildMethodologyCatalog,
  executionPlanFromMethodologyCatalog,
  loadOrCreateMethodologyCatalog,
  methodologyCatalogKey,
  writeMethodologyCatalog,
} from '../methodology-catalog.js';
import { CORE_FILES } from './fixtures/repo-files.js';

const REF = 'a'.repeat(40);
const fetchCoreFilesSpy = vi.hoisted(() => vi.fn());
vi.mock('../repo-fetch.js', async (importOriginal) => ({
  ...(await importOriginal()),
  fetchCoreFiles: fetchCoreFilesSpy,
}));
const s3Mock = mockClient(S3Client);

beforeEach(() => {
  s3Mock.reset();
  fetchCoreFilesSpy.mockReset().mockResolvedValue(CORE_FILES);
});

describe('methodology catalog', () => {
  it('captures structured methodology without embedding Markdown bodies', () => {
    const parsed = buildFromFiles(CORE_FILES);
    const catalog = buildMethodologyCatalog({ ref: REF, ...parsed });

    expect(methodologyCatalogKey(REF)).toBe(`aidlc-catalogs/v1/${REF}.json`);
    expect(catalog.workflow.sourceRef).toBe(REF);
    expect(catalog.blocks.STAGE.length).toBeGreaterThan(0);
    expect(catalog.blocks.STAGE[0]).not.toHaveProperty('body');
    expect(catalog.blocks.STAGE[0].bodyRef).toMatchObject({
      s3Key: expect.stringMatching(/^blocks\/bodies\/sha256\//),
      sha256: expect.any(String),
    });
    expect(catalog.blocks.SENSOR.find((block) => block.id === 'linter').scriptRef).toMatchObject({
      s3Key: expect.stringMatching(/^blocks\/scripts\/sha256\//),
      sha256: expect.any(String),
    });
  });

  it('reconstructs a runnable plan for the pinned workflow and scope', () => {
    const parsed = buildFromFiles(CORE_FILES);
    const catalog = buildMethodologyCatalog({ ref: REF, ...parsed });
    const result = executionPlanFromMethodologyCatalog({
      catalog,
      workflowId: 'aidlc-v2',
      workflowVersion: 1,
      scope: 'mvp',
    });

    expect(result.valid).toBe(true);
    expect(result.plan.stages.length).toBeGreaterThan(0);
    expect(result.methodologySourceRefs).toEqual([REF]);
    expect(result.methodologyPins.STAGE).toBeTruthy();
  });

  it('rebuilds and caches a missing historical catalog from the pinned commit', async () => {
    s3Mock.on(GetObjectCommand).rejects(Object.assign(new Error('missing'), { name: 'NoSuchKey' }));
    s3Mock.on(PutObjectCommand).resolves({});

    const catalog = await loadOrCreateMethodologyCatalog({
      s3: s3Mock,
      bucket: 'artifacts-test',
      ref: REF,
    });

    expect(catalog.ref).toBe(REF);
    expect(fetchCoreFilesSpy).toHaveBeenCalledWith(REF);
    expect(s3Mock.commandCalls(PutObjectCommand)[0].args[0].input).toMatchObject({
      Bucket: 'artifacts-test',
      Key: methodologyCatalogKey(REF),
      ContentType: 'application/json',
    });
  });

  it('reuses an identical immutable catalog when another writer wins', async () => {
    const catalog = buildMethodologyCatalog({ ref: REF, ...buildFromFiles(CORE_FILES) });
    s3Mock
      .on(PutObjectCommand)
      .rejects(Object.assign(new Error('exists'), { name: 'PreconditionFailed' }));
    s3Mock.on(GetObjectCommand).resolves({ Body: Buffer.from(JSON.stringify(catalog)) });

    await expect(
      writeMethodologyCatalog({
        s3: s3Mock,
        bucket: 'artifacts-test',
        catalog,
      }),
    ).resolves.toEqual(catalog);
  });
});
