import { beforeAll, beforeEach, describe, it, expect } from 'vitest';
import { mockClient } from 'aws-sdk-client-mock';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
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

  // Scan with the reseed FilterExpression: return only SYSTEM-owned partitions
  // (BLOCK#SYSTEM# / WF#SYSTEM#), mirroring the begins_with filter. Single page.
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

  it('seeds the V2 stage authored fields (condition, brownfield conditional_on, prose)', async () => {
    await handler({});
    // application-design carries a condition, brownfield-only consume edges,
    // and the human Inputs/Outputs prose — the A2 lossless round-trip fields.
    const stage = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(stage.condition).toMatch(/^Execute when new components/);
    expect(stage.c1_definition.inputsProse).toBeTruthy();
    expect(stage.c1_definition.outputsProse).toBeTruthy();
    const archEdge = stage.c1_definition.inputs.find((i) => i.artifact === 'architecture');
    expect(archEdge.conditionalOn).toBe('brownfield');
    // A greenfield-unconditional consume carries no conditionalOn.
    const reqEdge = stage.c1_definition.inputs.find((i) => i.artifact === 'requirements');
    expect(reqEdge.conditionalOn).toBeUndefined();
  });

  it('seeds the reviewer (llm-judged) verification half and wires it onto MVP stages', async () => {
    await handler({});
    // The 3 reviewers are llm-judged sensors bound to a reviewer agent.
    const review = tableStore.get('BLOCK#SYSTEM#SENSOR#architecture-review|V#latest');
    expect(review.mode).toBe('llm-judged');
    expect(review.reviewerAgent).toBe('aidlc-architecture-reviewer-agent');
    expect(review.maxIterations).toBe(2);
    // The reviewer agents exist as their own AGENT blocks.
    expect(tableStore.has('BLOCK#SYSTEM#AGENT#aidlc-architecture-reviewer-agent|V#latest')).toBe(
      true,
    );
    // application-design runs the architecture reviewer after its det. sensors.
    const stage = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(stage.c2_verification.sensors).toContain('architecture-review');
    // A non-MVP stage carries no reviewer — only its deterministic sensors.
    const intent = tableStore.get('BLOCK#SYSTEM#STAGE#intent-capture|V#latest');
    expect(intent.c2_verification.sensors).not.toContain('architecture-review');
  });

  it('seeds agent examples and a null rule pairing (reserved relation)', async () => {
    await handler({});
    const agent = tableStore.get('BLOCK#SYSTEM#AGENT#aidlc-product-agent|V#latest');
    expect(agent.examples).toEqual(['roadmap.md', 'personas.md']);
    const rule = tableStore.get('BLOCK#SYSTEM#RULE#aidlc-org|V#latest');
    expect(rule.pairing).toBeNull();
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

describe('seed-blocks reseed mode', () => {
  // Simulate the production bug: a stale baseline from an earlier seed. The
  // insert-only path skips it forever; reseed must refresh it.
  const seedStale = () => {
    // A stale stage block missing fields the current baseline adds.
    tableStore.set('BLOCK#SYSTEM#STAGE#application-design|V#latest', {
      pk: 'BLOCK#SYSTEM#STAGE#application-design',
      sk: 'V#latest',
      tenantId: 'SYSTEM',
      blockType: 'STAGE',
      blockId: 'application-design',
      name: 'Application Design',
      condition: undefined, // the stale row had no condition
    });
    // A stale workflow partition with the pre-rename GROUPING# rows + 1 placement.
    tableStore.set('WF#SYSTEM#aidlc-v2|META', {
      pk: 'WF#SYSTEM#aidlc-v2',
      sk: 'META',
      tenantId: 'SYSTEM',
      name: 'AI-DLC v2 (default)',
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
    // Insert-only first: proves the bug — the stale stage is left as-is.
    await handler({});
    const afterInsert = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(afterInsert.condition).toBeUndefined();
    expect(afterInsert.leadAgent).toBeUndefined();

    // Reseed: the stage is rewritten from the current baseline (now has fields).
    const result = await handler({ reseed: true });
    expect(result.reseed).toBe(true);
    expect(result.cleared).toBeGreaterThan(0);
    expect(result.skipped).toHaveLength(0); // nothing skipped — partitions were cleared first
    const refreshed = tableStore.get('BLOCK#SYSTEM#STAGE#application-design|V#latest');
    expect(refreshed.leadAgent).toBe('aidlc-architect-agent');
    expect(refreshed.condition).toMatch(/^Execute when new components/);
  });

  it('clears orphaned rows under since-renamed SKs (old GROUPING#) and rebuilds PHASE#', async () => {
    seedStale();
    await handler({ reseed: true });
    // The orphaned pre-rename row is gone; the current PHASE# tree is present.
    expect(tableStore.has('WF#SYSTEM#aidlc-v2|GROUPING#01#ideation')).toBe(false);
    expect(tableStore.has('WF#SYSTEM#aidlc-v2|PHASE#02#ideation')).toBe(true);
    // And the full 32-placement set landed (was 1 in the stale partition).
    const placements = [...tableStore.keys()].filter((k) =>
      k.startsWith('WF#SYSTEM#aidlc-v2|PLACEMENT#'),
    );
    expect(placements.length).toBe(BASELINE_WORKFLOWS[0].placements.length);
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
    expect(tableStore.size).toBe(before); // nothing deleted or written
  });
});
