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
//   # Apply
//   aws lambda invoke \
//     --function-name $(terraform output -raw seed_blocks_lambda_name) \
//     --payload '{}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
// Idempotent: a conditional write skips any block that already exists, so
// re-running only inserts blocks added to the baseline since the last run.
// Stays deployed indefinitely — OSS forks are on their own upgrade timelines.

import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { SYSTEM_TENANT } from '../shared/tenant.js';
import { BASELINE_BLOCKS } from '../shared/baseline-blocks.js';
import { LATEST, blockPk, versionSk, catalogGsi1Pk, buildBodyRef } from '../shared/blocks.js';

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

export const handler = async (event = {}) => {
  const dryRun = event?.dryRun === true;
  const now = new Date().toISOString();
  const seeded = [];
  const skipped = [];

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

  const result = { dryRun, total: BASELINE_BLOCKS.length, seeded, skipped };
  console.log('seed-blocks result:', JSON.stringify(result));
  return result;
};
