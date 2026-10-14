// This host can read jobs and send pointers, but cannot claim, mutate, publish,
// access credentials, or execute package code. The worker remains the owner.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { createNativePackageJobs } from '../shared/native-package-jobs.js';
import { createNativeRepairScan, nativeRepairClientOptions } from '../shared/native-repair-scan.js';

export const createNativePackageRepair = ({
  ddb,
  sqs,
  tableName,
  checkpointTable,
  queueUrl,
  now = Date.now,
  logger = console,
  repairOptions = {},
}) => {
  const repair = createNativeRepairScan({
    ...repairOptions,
    ddb,
    tableName,
    checkpointTable,
    scope: 'packages',
    keyFields: ['projectId', 'jobId'],
    now,
    logger,
    scanInput: {
      FilterExpression: '#state IN (:queued, :running)',
      ExpressionAttributeNames: { '#state': 'state' },
      ExpressionAttributeValues: { ':queued': 'QUEUED', ':running': 'RUNNING' },
    },
    visit: async (row, { signal, stats }) => {
      // Reload through the existing strict owner reader. Neither a stale scan
      // nor raw DLQ/stream body supplies source, selected version, or attempts.
      const jobs = createNativePackageJobs({
        ddb: { send: (command) => ddb.send(command, { abortSignal: signal }) },
        tableName,
        now,
      });
      stats.jobReads++;
      const job = await jobs.get({ projectId: row.projectId, jobId: row.jobId });
      if (
        !job ||
        (job.state !== 'QUEUED' && !(job.state === 'RUNNING' && job.leaseExpiresAt <= now()))
      )
        return;
      const result = await sqs.send(
        new SendMessageCommand({
          QueueUrl: queueUrl,
          MessageBody: JSON.stringify({
            schemaVersion: 1,
            projectId: job.projectId,
            jobId: job.jobId,
          }),
        }),
        { abortSignal: signal },
      );
      if (!result.MessageId) throw new Error('Native package repair unacknowledged');
      stats.sends++;
    },
  });
  return (event, context) => {
    if (event?.source !== 'aws.events') throw new Error('Native package repair event invalid');
    return repair(context);
  };
};

export const handler = (event, context) => {
  if (process.env.NATIVE_PACKAGE_JOBS_ENABLED !== 'true')
    throw new Error('Native package repair disabled');
  return createNativePackageRepair({
    ddb: DynamoDBDocumentClient.from(new DynamoDBClient(nativeRepairClientOptions)),
    sqs: new SQSClient(nativeRepairClientOptions),
    tableName: process.env.NATIVE_PACKAGE_JOBS_TABLE,
    checkpointTable: process.env.NATIVE_REPAIR_CHECKPOINT_TABLE,
    queueUrl: process.env.NATIVE_PACKAGE_JOBS_QUEUE_URL,
  })(event, context);
};
