import { isDeepStrictEqual } from 'node:util';
import { chmod, lstat, mkdtemp, opendir, realpath, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { GetCommand, PutCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { createNativePackageJobs } from '../../shared/native-package-jobs.js';
import { createNativeReleaseFixture } from '../../shared/test/fixtures/native-release.js';
import { verifyNativeReleaseDirectory } from '../../shared/native-runtime-package.js';
import { loadNativePackage } from '../../agentcore/native/package-loader.js';
import { describeNativePackagePin } from '../../shared/native-package-pin.js';
import { workflowSourceIdentity } from '../../shared/workflow-source-bindings.js';

export const QUEUE = 'arn:aws:sqs:us-east-1:123456789012:native-packages';
export const TABLE = 'native-package-worker-tests';
export const KEY = { projectId: 'project-1', jobId: '11111111-1111-4111-8111-111111111111' };
export const REVISION = '22222222-2222-4222-8222-222222222222';
export const record = (overrides = {}) => ({
  messageId: 'message-1',
  eventSource: 'aws:sqs',
  eventSourceARN: QUEUE,
  body: JSON.stringify({ schemaVersion: 1, ...KEY }),
  ...overrides,
});
export const event = (...records) => ({ Records: records.length ? records : [record()] });
export const deferred = () => {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
export const removeTree = async (root) => {
  const visit = async (directory) => {
    const stat = await lstat(directory).catch((error) => {
      if (error.code === 'ENOENT') return null;
      throw error;
    });
    if (!stat?.isDirectory() || stat.isSymbolicLink()) return;
    await chmod(directory, 0o700);
    for await (const entry of await opendir(directory)) {
      if (entry.isDirectory()) await visit(join(directory, entry.name));
    }
  };
  await visit(root);
  await rm(root, { recursive: true, force: true });
};

// Execute the real store's conditional SDK commands against mutable rows.
// Conditions are evaluated at write time, after hooks may advance a lease.
export const createJobDdb = () => {
  const rows = new Map();
  const calls = [];
  const hooks = {};
  const id = (key) => JSON.stringify([key.projectId, key.jobId]);
  const read = (key = KEY) => structuredClone(rows.get(id(key)));
  const write = (row) => rows.set(id(row), structuredClone(row));
  const satisfied = (input) => {
    const row = read(input.Key ?? input.Item);
    return input.ConditionExpression.split(' AND ').every((clause) => {
      const absent = /^attribute_not_exists\((#[\w]+)\)$/.exec(clause);
      if (absent) return !row || !Object.hasOwn(row, input.ExpressionAttributeNames[absent[1]]);
      const comparison = /^(#[\w]+) (=|>|<=) (:[\w]+)$/.exec(clause);
      if (!comparison) throw new Error('Unsupported fixture condition');
      const left = row?.[input.ExpressionAttributeNames[comparison[1]]];
      const right = input.ExpressionAttributeValues[comparison[3]];
      if (comparison[2] === '=') return isDeepStrictEqual(left, right);
      return comparison[2] === '>' ? left > right : left <= right;
    });
  };
  return {
    rows,
    calls,
    hooks,
    read,
    ddb: {
      async send(command) {
        calls.push(command);
        await hooks.before?.(command);
        const input = command.input;
        if (input.TableName !== TABLE) throw new Error('Unexpected fixture table');
        let result;
        if (command instanceof GetCommand) {
          if (input.ConsistentRead !== true) throw new Error('Authoritative read required');
          result = { Item: read(input.Key) };
        } else {
          if (!satisfied(input))
            throw Object.assign(new Error('Conditional write rejected'), {
              name: 'ConditionalCheckFailedException',
            });
          if (command instanceof PutCommand) {
            write(input.Item);
            result = {};
          } else if (command instanceof UpdateCommand) {
            const row = read(input.Key);
            const update = /^SET (.*?)(?: REMOVE (.*))?$/.exec(input.UpdateExpression);
            for (const assignment of update[1].split(', ')) {
              const [name, value] = assignment.split(' = ');
              row[input.ExpressionAttributeNames[name]] = structuredClone(
                input.ExpressionAttributeValues[value],
              );
            }
            for (const name of update[2]?.split(', ') ?? [])
              delete row[input.ExpressionAttributeNames[name]];
            write(row);
            result = { Attributes: read(input.Key) };
          } else throw new Error('Unexpected fixture command');
        }
        await hooks.after?.(command, result);
        return result;
      },
    },
  };
};

export const fixture = async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'native-package-worker-test-')));
  const release = await createNativeReleaseFixture(join(root, 'release'));
  const pin = await verifyNativeReleaseDirectory(release);
  const materialization = await loadNativePackage({
    releaseDirectory: release.directory,
    cacheDirectory: join(root, 'original-cache'),
    pin,
    attestation: null,
  });
  const request = {
    ...KEY,
    sourceId: workflowSourceIdentity(pin.source.provider, pin.source.repository).sourceId,
    actorId: 'trusted-actor',
    bindingRevision: REVISION,
    requestedRelease: 'latest',
  };
  const description = describeNativePackagePin(pin, null);
  const candidate = {
    schemaVersion: 1,
    projectId: request.projectId,
    sourceId: request.sourceId,
    bindingRevision: REVISION,
    requestedRelease: 'latest',
    packagePin: { ...description.identity, packageId: description.packageId },
    attestation: null,
    materializationId: description.materializationId,
  };
  const storage = createJobDdb();
  let time = 1000;
  const jobs = createNativePackageJobs({
    ddb: storage.ddb,
    tableName: TABLE,
    now: () => time,
    leaseMs: 10_000,
    maxAttempts: 3,
  });
  await jobs.create(request);
  return {
    root,
    release,
    pin,
    materialization,
    request,
    candidate,
    storage,
    jobs,
    now: () => time,
    expire: () => {
      time += 20_000;
    },
  };
};
