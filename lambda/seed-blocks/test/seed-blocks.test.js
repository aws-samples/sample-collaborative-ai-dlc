import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { BASELINE_BLOCKS, BASELINE_WORKFLOWS } from '../../shared/baseline-blocks.js';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';

const ddbMock = mockClient(DynamoDBDocumentClient);
const s3Mock = mockClient(S3Client);

// In-memory table whose PutItem honors the `attribute_not_exists(pk)` guard the
// seed lambda relies on for idempotency.
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

  s3Mock.on(PutObjectCommand).callsFake((input) => {
    s3Store.set(input.Key, input.Body);
    return {};
  });
};

let handler;

beforeAll(async () => {
  process.env.BLOCKS_TABLE = BLOCKS_TABLE;
  process.env.ARTIFACTS_BUCKET = ARTIFACTS_BUCKET;
  ({ handler } = await import('../index.js'));
});

beforeEach(() => {
  installFakes();
});

describe('seed-blocks handler', () => {
  it('dry-run writes nothing but reports every baseline block', async () => {
    const result = await handler({ dryRun: true });
    expect(result.dryRun).toBe(true);
    expect(result.seeded).toHaveLength(BASELINE_BLOCKS.length + BASELINE_WORKFLOWS.length);
    expect(result.skipped).toHaveLength(0);
    expect(tableStore.size).toBe(0);
    expect(s3Store.size).toBe(0);
  });

  it('seeds each baseline block as a SYSTEM V#latest + V#1 pair', async () => {
    const result = await handler({});
    expect(result.seeded).toHaveLength(BASELINE_BLOCKS.length + BASELINE_WORKFLOWS.length);
    expect(result.skipped).toHaveLength(0);
    for (const block of BASELINE_BLOCKS) {
      const pk = `BLOCK#SYSTEM#${block.type}#${block.id}`;
      expect(tableStore.has(`${pk}|V#latest`)).toBe(true);
      expect(tableStore.has(`${pk}|V#1`)).toBe(true);
      // The catalog keys live on V#latest only.
      expect(tableStore.get(`${pk}|V#latest`).GSI1PK).toBe(`TENANT#SYSTEM#${block.type}`);
      expect(tableStore.get(`${pk}|V#1`).GSI1PK).toBeUndefined();
    }
  });

  it('externalizes any baseline body to S3 and stores a pointer, not inline text', async () => {
    await handler({});
    // The baseline currently models structured frontmatter only — bodies (the
    // V2 instructions/personas/rule prose) are a deferred data-seam addition.
    // Whenever a baseline block does carry a body, it must be externalized.
    // (The S3 round-trip itself is covered in the building-blocks suite.)
    for (const block of BASELINE_BLOCKS.filter((b) => b.body)) {
      const item = tableStore.get(`BLOCK#SYSTEM#${block.type}#${block.id}|V#latest`);
      expect(item.bodyRef).toBeTruthy();
      expect(item.bodyRef.s3Key).toMatch(/^blocks\/bodies\/sha256\//);
      expect(item.body).toBeUndefined();
      expect(s3Store.get(item.bodyRef.s3Key)).toBe(block.body);
    }
  });

  it('is idempotent: a second run skips everything already seeded', async () => {
    await handler({});
    const sizeAfterFirst = tableStore.size;
    const result = await handler({});
    expect(result.seeded).toHaveLength(0);
    expect(result.skipped).toHaveLength(BASELINE_BLOCKS.length + BASELINE_WORKFLOWS.length);
    expect(tableStore.size).toBe(sizeAfterFirst);
  });

  it('seeds each baseline workflow as a SYSTEM partition (META + phases + placements)', async () => {
    await handler({});
    for (const wf of BASELINE_WORKFLOWS) {
      const pk = `WF#SYSTEM#${wf.id}`;
      const meta = tableStore.get(`${pk}|META`);
      expect(meta).toBeTruthy();
      expect(meta.tenantId).toBe('SYSTEM');
      expect(meta.status).toBe('PUBLISHED');
      // Listed via the workflow catalog index.
      expect(meta.GSI1PK).toBe('TENANT#SYSTEM#WORKFLOW');
      // Inline phases + stage placements landed in the partition.
      for (const phase of wf.phases ?? []) {
        expect(tableStore.has(`${pk}|PHASE#${phase.path}#${phase.phaseId}`)).toBe(true);
      }
      for (const p of wf.placements ?? []) {
        expect(tableStore.has(`${pk}|PLACEMENT#${p.stageId}`)).toBe(true);
      }
    }
  });
});
