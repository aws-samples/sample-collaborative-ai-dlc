// Bulk admin path for the tracker provider abstraction migration (issue
// #194). Walks every Project + Sprint in Neptune. The per-project flow that
// users hit through the ProjectSettings UI lives in lambda/projects under
// POST /projects/{projectId}/migrate-tracker — this lambda is the operator
// counterpart for "migrate everything in one shot, no UI needed."
//
// VPC-attached, invoked directly via `aws lambda invoke`. Reuses the
// neptune-reader IAM role (already has WriteDataViaQuery on the cluster).
//
// Invocation:
//
//   # Dry-run first to preview
//   aws lambda invoke \
//     --function-name $(terraform output -raw migrate_tracker_fields_lambda_name) \
//     --payload '{"dryRun":true}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
//   # Apply
//   aws lambda invoke \
//     --function-name $(terraform output -raw migrate_tracker_fields_lambda_name) \
//     --payload '{}' --cli-binary-format raw-in-base64-out /tmp/out.json
//
// Idempotent (re-running is a no-op once everything is on the new shape).
// Stays deployed indefinitely — we have no control over OSS users' upgrade
// timelines, so the migration tool is permanent.

import gremlin from 'gremlin';
import { PartitionStrategy } from 'gremlin/lib/process/traversal-strategy.js';
import { fromNodeProviderChain } from '@aws-sdk/credential-providers';
import { getUrlAndHeaders } from 'gremlin-aws-sigv4/lib/utils.js';
import { runTrackerMigration } from '../shared/tracker-migration.js';

const DriverRemoteConnection = gremlin.driver.DriverRemoteConnection;
const traversal = gremlin.process.AnonymousTraversalSource.traversal;

const getConnection = async () => {
  const host = process.env.NEPTUNE_ENDPOINT;
  if (!host) throw new Error('NEPTUNE_ENDPOINT is required');
  const port = process.env.GREMLIN_PORT ?? '8182';
  const protocol = process.env.GREMLIN_PROTOCOL ?? 'wss';

  if (protocol === 'ws') {
    return new DriverRemoteConnection(`ws://${host}:${port}/gremlin`);
  }

  const credentials = await fromNodeProviderChain()();
  credentials.region = process.env.AWS_REGION ?? 'us-east-1';
  const { url, headers } = getUrlAndHeaders(host, port, credentials, '/gremlin', protocol);
  return new DriverRemoteConnection(url, { headers });
};

export const handler = async (event = {}) => {
  const dryRun = event?.dryRun === true;
  const conn = await getConnection();
  try {
    let g = traversal().withRemote(conn);
    if (process.env.GREMLIN_PARTITION) {
      g = g.withStrategies(
        new PartitionStrategy({
          partitionKey: '_partition',
          writePartition: process.env.GREMLIN_PARTITION,
          readPartitions: [process.env.GREMLIN_PARTITION],
        }),
      );
    }
    const result = await runTrackerMigration(g, { dryRun });
    console.log('migration result:', JSON.stringify(result));
    return result;
  } finally {
    try {
      await conn.close();
    } catch {}
  }
};
