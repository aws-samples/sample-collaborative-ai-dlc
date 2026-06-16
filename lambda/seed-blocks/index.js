// Seeds the shipped SYSTEM baseline block library into the blocks table + the
// artifacts bucket. The blocks themselves live in shared/baseline-blocks.js;
// this lambda just writes them.
//
// Admin one-shot, invoked directly via `aws lambda invoke` (no API route):
//
//   # Dry-run first to preview what would be written
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Apply (insert-only: adds blocks new since the last run, skips existing)
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Reseed (refresh the whole SYSTEM baseline — see below)
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{"reseed":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
// Two modes:
//   - Default (insert-only): a conditional write skips any block that already
//     exists, so re-running only inserts blocks added to the baseline since the
//     last run. Safe, but it CANNOT update an existing baseline block — once a
//     SYSTEM partition exists, later field changes are silently skipped, and
//     rows under a since-renamed SK (e.g. a stage's old GROUPING# items) are
//     left orphaned because the insert path can't reach them.
//   - reseed: the vendor baseline re-ships on every deploy, so it must be
//     re-seedable. `{"reseed":true}` first DELETES every SYSTEM-owned partition
//     (BLOCK#SYSTEM#* and WF#SYSTEM#*), clearing orphans, then writes the full
//     current baseline fresh. Scoped to SYSTEM only — customer forks live in
//     BLOCK#<tenant># / WF#<tenant># partitions and are never scanned or
//     touched. Combine with dryRun to preview the clear without deleting.
//
// Stays deployed indefinitely — OSS forks are on their own upgrade timelines.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  PutCommand,
  ScanCommand,
  BatchWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SYSTEM_TENANT } from '../shared/tenant.js';
import { BASELINE_BLOCKS, BASELINE_WORKFLOWS } from '../shared/baseline-blocks.js';
import { LATEST, blockPk, versionSk, catalogGsi1Pk, buildBodyRef } from '../shared/blocks.js';
import {
  META,
  workflowPk,
  phaseSk,
  placementSk,
  ruleRefSk,
  workflowGsi1Pk,
} from '../shared/workflows.js';

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const blocksTable = () => process.env.BLOCKS_TABLE;
const artifactsBucket = () => process.env.ARTIFACTS_BUCKET;

const isConditionalCheckFailed = (err) => err?.name === 'ConditionalCheckFailedException';

// Builds the two stored items (V#latest pointer + V#1 snapshot) for a baseline
// block, with its body (if any) externalized to S3.
const buildItems = (block, bodyRef, now) => {
  const { type, id, name, body, ...attrs } = block;
  void body; // body is externalized into bodyRef, not stored inline
  const base = {
    pk: blockPk(SYSTEM_TENANT, type, id),
    tenantId: SYSTEM_TENANT,
    blockType: type,
    blockId: id,
    name,
    version: 1,
    bodyRef,
    createdAt: now,
    updatedAt: now,
    ...attrs,
  };
  return {
    latest: { ...base, sk: LATEST, GSI1PK: catalogGsi1Pk(SYSTEM_TENANT, type), GSI1SK: name },
    snapshot: { ...base, sk: versionSk(1) },
  };
};

// Builds the items for a baseline workflow partition: the META header (carrying
// the workflow catalog GSI1 keys), the inline phase tree, and the stage
// placements. References the baseline blocks; never copies them.
const buildWorkflowItems = (wf, now) => {
  const pk = workflowPk(SYSTEM_TENANT, wf.id);
  const meta = {
    pk,
    sk: META,
    type: 'Workflow',
    tenantId: SYSTEM_TENANT,
    workflowId: wf.id,
    name: wf.name,
    objective: wf.objective ?? '',
    basedOn: null,
    defaultScope: wf.defaultScope ?? null,
    status: 'PUBLISHED',
    createdAt: now,
    updatedAt: now,
    GSI1PK: workflowGsi1Pk(SYSTEM_TENANT),
    GSI1SK: wf.name,
  };
  const phases = (wf.phases ?? []).map((node) => ({
    pk,
    sk: phaseSk(node.path, node.phaseId),
    type: 'Phase',
    phaseId: node.phaseId,
    name: node.name ?? node.phaseId,
    kind: node.kind ?? 'phase',
    path: node.path,
    parentPath: node.path.includes('.') ? node.path.split('.').slice(0, -1).join('.') : null,
    order: Number(node.path.split('.').at(-1)),
  }));
  const placements = (wf.placements ?? []).map((p) => ({
    pk,
    sk: placementSk(p.stageId),
    type: 'StagePlacement',
    stageId: p.stageId,
    stageTenant: p.stageTenant ?? SYSTEM_TENANT,
    pinnedVersion: p.pinnedVersion ?? null,
    phasePath: p.phasePath ?? null,
    order: typeof p.order === 'number' ? p.order : 0,
    scopeMembership: p.scopeMembership ?? {},
  }));
  const ruleRefs = (wf.ruleRefs ?? []).map((rr) => ({
    pk,
    sk: ruleRefSk(rr.layer, rr.ruleId),
    type: 'RuleRef',
    ruleId: rr.ruleId,
    layer: rr.layer,
    ruleTenant: rr.ruleTenant ?? SYSTEM_TENANT,
  }));
  return { meta, children: [...phases, ...placements, ...ruleRefs] };
};

// Deletes every SYSTEM-owned partition (BLOCK#SYSTEM#* and WF#SYSTEM#*) so the
// baseline can be rewritten fresh. Scoped by a FilterExpression on the pk
// prefix — customer forks (BLOCK#<tenant>#, WF#<tenant>#) are never matched.
// A Scan is acceptable here: this is a rarely-run admin op on a small table,
// not a hot path. Returns the count of deleted items.
const clearSystemPartitions = async (dryRun) => {
  const keys = [];
  let lastKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: blocksTable(),
        FilterExpression: 'begins_with(pk, :blockSys) OR begins_with(pk, :wfSys)',
        ExpressionAttributeValues: {
          ':blockSys': `BLOCK#${SYSTEM_TENANT}#`,
          ':wfSys': `WF#${SYSTEM_TENANT}#`,
        },
        ProjectionExpression: 'pk, sk',
        ExclusiveStartKey: lastKey,
      }),
    );
    for (const item of page.Items || []) keys.push({ pk: item.pk, sk: item.sk });
    lastKey = page.LastEvaluatedKey;
  } while (lastKey);

  if (dryRun) return keys.length;

  // BatchWrite deletes in chunks of 25.
  for (let i = 0; i < keys.length; i += 25) {
    const group = keys.slice(i, i + 25);
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [blocksTable()]: group.map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }
  return keys.length;
};

export const handler = async (event = {}) => {
  const dryRun = event?.dryRun === true;
  const reseed = event?.reseed === true;
  const now = new Date().toISOString();
  const seeded = [];
  const skipped = [];

  // Reseed: clear the SYSTEM baseline first so the writes below land fresh.
  // After the clear, no SYSTEM pk exists, so the attribute_not_exists guards
  // below all pass and write the full current baseline. (On dryRun we only
  // count what would be cleared; nothing is deleted or written.)
  let cleared = 0;
  if (reseed) {
    cleared = await clearSystemPartitions(dryRun);
  }

  for (const block of BASELINE_BLOCKS) {
    const ref = block.body ? buildBodyRef(block.body) : null;

    if (dryRun) {
      seeded.push(`${block.type}#${block.id}`);
      continue;
    }

    if (ref) {
      await s3.send(
        new PutObjectCommand({
          Bucket: artifactsBucket(),
          Key: ref.s3Key,
          Body: block.body,
          ContentType: 'text/markdown',
        }),
      );
    }

    const { latest, snapshot } = buildItems(block, ref, now);
    try {
      // Guard on V#latest only — its absence means the block is new. The
      // snapshot write follows unconditionally so a half-seeded block heals.
      await ddb.send(
        new PutCommand({
          TableName: blocksTable(),
          Item: latest,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
      await ddb.send(new PutCommand({ TableName: blocksTable(), Item: snapshot }));
      seeded.push(`${block.type}#${block.id}`);
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        skipped.push(`${block.type}#${block.id}`);
        continue;
      }
      throw err;
    }
  }

  // Workflows: the "from default" fork sources. Guard on the META item; only
  // when it is newly created do we write the phase/placement children, so
  // re-running never disturbs an existing baseline workflow.
  for (const wf of BASELINE_WORKFLOWS) {
    if (dryRun) {
      seeded.push(`WORKFLOW#${wf.id}`);
      continue;
    }
    const { meta, children } = buildWorkflowItems(wf, now);
    try {
      await ddb.send(
        new PutCommand({
          TableName: blocksTable(),
          Item: meta,
          ConditionExpression: 'attribute_not_exists(pk)',
        }),
      );
    } catch (err) {
      if (isConditionalCheckFailed(err)) {
        skipped.push(`WORKFLOW#${wf.id}`);
        continue;
      }
      throw err;
    }
    for (const child of children) {
      await ddb.send(new PutCommand({ TableName: blocksTable(), Item: child }));
    }
    seeded.push(`WORKFLOW#${wf.id}`);
  }

  const result = {
    dryRun,
    reseed,
    cleared,
    total: BASELINE_BLOCKS.length + BASELINE_WORKFLOWS.length,
    seeded,
    skipped,
  };
  console.log('seed-blocks result:', JSON.stringify(result));
  return result;
};
