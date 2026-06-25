import { beforeAll, beforeEach, describe, it, expect, vi } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { CORE_FILES } from '../../shared/test/fixtures/repo-files.js';
import { buildFromFiles } from '../../shared/block-mappers.js';

const BLOCKS_TABLE = 'blocks-test';
const ARTIFACTS_BUCKET = 'artifacts-test';
const REF = 'testsha';

// Mock the repo fetch so the seed reads the fixture tree, not the network.
vi.mock('../../shared/repo-fetch.js', () => ({
  fetchCoreFiles: vi.fn(async () => CORE_FILES),
}));

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
    s3Store.set(input.Key, input.Body);
    return {};
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
    const result = await handler({ ref: 'override-ref' });
    expect(result.ref).toBe('override-ref');
    expect(s3Store.has('aidlc-runtime/override-ref/manifest.json')).toBe(true);
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
