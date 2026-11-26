#!/usr/bin/env node
// Operator tool for the native runtime-image lifecycle.
//
//   referenced  Read-only. Lists the immutable image pins still required by
//               resumable native runs (or retained recovery checkpoints) and
//               proves each digest is still present in ECR. Run it before and
//               after a deployment; a non-zero exit means a required pin is
//               missing and the deployment must not proceed or be accepted.
//   revoke      Administrator-only, irreversible. Writes the protected
//               revocation record for one digest, then enqueues the affected
//               active runs so the controller fences and stops them promptly.
//               Committed results remain readable.
//
// Output never includes prompts, credentials, runtime session IDs or raw
// execution rows: runs are identified by a scope hash only.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { parseArgs } from 'node:util';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { DescribeImagesCommand, ECRClient } from '@aws-sdk/client-ecr';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import {
  nativeImageRenewalEligible,
  nativeRuntimeImageKey,
} from '../lambda/native-runtime-control/runtime-images.js';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const REASON = /^[a-z][a-z0-9_]{0,63}$/;
const PRINCIPAL = /^arn:aws(?:-[a-z]+)*:(?:iam|sts)::[0-9]{12}:[A-Za-z0-9@._:/+=-]{1,200}$/;
const ACTIVE = new Set(['REQUESTED', 'UPGRADING', 'DISPATCHING', 'RUNNING', 'RECOVERING']);

const usage = () => {
  console.error(
    [
      'Usage:',
      '  native-runtime-images.mjs referenced --table <bindings-table> --repository <ecr-repo>',
      '  native-runtime-images.mjs revoke --table <bindings-table> --digest <sha256:...>',
      '      --reason <code> --confirm <sha256:...> --queue-url <execution-queue-url>',
    ].join('\n'),
  );
  process.exit(2);
};

export const scopeHash = (scope) =>
  createHash('sha256')
    .update(JSON.stringify({ projectId: scope?.projectId, executionId: scope?.executionId }))
    .digest('hex')
    .slice(0, 16);

export const executionRows = async (ddb, table) => {
  const rows = [];
  let ExclusiveStartKey;
  do {
    const page = await ddb.send(
      new ScanCommand({
        TableName: table,
        FilterExpression: 'sk = :sk',
        ExpressionAttributeValues: { ':sk': 'EXECUTION' },
        // Protected references decide which pins remain required.
        ConsistentRead: true,
        ExclusiveStartKey,
      }),
    );
    rows.push(...(page.Items ?? []));
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey);
  return rows;
};

/** Pure: group eligible runs by pinned digest. */
export const requiredPins = (rows) => {
  const pins = new Map();
  for (const row of rows) {
    const digest = row?.configuration?.image?.digest;
    if (!DIGEST.test(digest ?? '') || !nativeImageRenewalEligible(row)) continue;
    const entry = pins.get(digest) ?? { digest, uri: row.configuration.image.uri, runs: [] };
    entry.runs.push({ scope: scopeHash(row.scope), status: row.status });
    pins.set(digest, entry);
  }
  return [...pins.values()].toSorted((a, b) => a.digest.localeCompare(b.digest));
};

const present = async (ecr, repository, digest) => {
  try {
    const result = await ecr.send(
      new DescribeImagesCommand({ repositoryName: repository, imageIds: [{ imageDigest: digest }] }),
    );
    return (result.imageDetails ?? []).some((image) => image.imageDigest === digest);
  } catch (error) {
    if (error?.name === 'ImageNotFoundException') return false;
    throw error;
  }
};

const referenced = async ({ table, repository }) => {
  if (!table || !repository) usage();
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const ecr = new ECRClient({});
  const pins = requiredPins(await executionRows(ddb, table));
  for (const pin of pins) pin.presentInEcr = await present(ecr, repository, pin.digest);
  const missing = pins.filter((pin) => !pin.presentInEcr);
  console.log(JSON.stringify({ checkedAt: new Date().toISOString(), pins, missing: missing.length }, null, 2));
  if (missing.length) process.exit(1);
};

// The authenticated administrator principal, never a caller-supplied label.
const callerPrincipal = () => {
  const output = execFileSync('aws', ['sts', 'get-caller-identity', '--output', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  const arn = JSON.parse(output).Arn;
  if (!PRINCIPAL.test(arn ?? '')) throw new Error('Unable to verify the administrator principal');
  return arn;
};

const revoke = async ({ table, digest, reason, confirm, 'queue-url': queueUrl }) => {
  if (!table || !DIGEST.test(digest ?? '') || !REASON.test(reason ?? '')) usage();
  if (confirm !== digest) {
    console.error('Revocation is irreversible; repeat the exact digest with --confirm.');
    process.exit(2);
  }
  const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const affected = (await executionRows(ddb, table)).filter(
    (row) => row?.configuration?.image?.digest === digest && ACTIVE.has(row.status),
  );
  // Fencing an active process needs the controller; refuse to write a
  // revocation that could not also be delivered to the running executions.
  if (affected.length && !queueUrl) {
    console.error(
      `${affected.length} active run(s) use this image; pass --queue-url so the controller fences them.`,
    );
    process.exit(2);
  }
  const record = {
    ...nativeRuntimeImageKey(digest),
    schemaVersion: 1,
    digest,
    revokedAt: Date.now(),
    revokedBy: callerPrincipal(),
    reasonCode: reason,
  };
  let created = true;
  try {
    await ddb.send(
      new PutCommand({
        TableName: table,
        Item: record,
        ConditionExpression: 'attribute_not_exists(pk)',
      }),
    );
  } catch (error) {
    if (error?.name !== 'ConditionalCheckFailedException') throw error;
    created = false;
  }
  // Re-read after the write: a run started meanwhile must also be fenced.
  const active = (await executionRows(ddb, table)).filter(
    (row) => row?.configuration?.image?.digest === digest && ACTIVE.has(row.status),
  );
  const sqs = queueUrl ? new SQSClient({}) : null;
  const runs = [];
  for (const row of active) {
    let enqueued = false;
    try {
      const sent = await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            projectId: row.scope.projectId,
            executionId: row.scope.executionId,
          }),
        }),
      );
      enqueued = Boolean(sent.MessageId);
    } catch {
      enqueued = false;
    }
    runs.push({ scope: scopeHash(row.scope), status: row.status, enqueued });
  }
  const incomplete = runs.filter((run) => !run.enqueued).length;
  console.log(
    JSON.stringify(
      {
        revoked: digest,
        recordCreated: created,
        reasonCode: reason,
        // A queued reconcile is a request to fence, not proof a process
        // stopped: confirm each run reaches FAILED/native_execution_image_revoked.
        fence: incomplete ? 'incomplete' : active.length ? 'requested' : 'not-required',
        activeRuns: runs,
      },
      null,
      2,
    ),
  );
  if (incomplete) process.exit(3);
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const [command, ...rest] = process.argv.slice(2);
  const { values } = parseArgs({
    args: rest,
    options: {
      table: { type: 'string' },
      repository: { type: 'string' },
      digest: { type: 'string' },
      reason: { type: 'string' },
      confirm: { type: 'string' },
      'queue-url': { type: 'string' },
    },
  });
  if (command === 'referenced') await referenced(values);
  else if (command === 'revoke') await revoke(values);
  else usage();
}
