#!/usr/bin/env node
// Bounded, disposable DynamoDB Local probe; no AWS/provider/real queue effects.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { BatchWriteCommand, DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { nativeRuntimeBindingKey } from '../lambda/shared/native-runtime-binding.js';
import { createNativeWakeupBridge } from '../lambda/native-runtime-control/wakeup.js';
import { createNativePackageRepair } from '../lambda/native-package-worker/repair.js';
import { createNativePackageJobs } from '../lambda/shared/native-package-jobs.js';

const arg = (name, fallback) =>
  process.argv
    .find((v) => v.startsWith(`--${name}=`))
    ?.split('=')
    .slice(1)
    .join('=') ?? fallback;
const endpoint = new URL(arg('endpoint', 'http://127.0.0.1:18764'));
assert(
  ['127.0.0.1', 'localhost', '[::1]'].includes(endpoint.hostname) &&
    endpoint.protocol === 'http:' &&
    !endpoint.username &&
    !endpoint.password,
  'Loopback DynamoDB Local only',
);
const rows = Number(arg('rows', 12000));
const concurrency = Number(arg('concurrency', 4));
const latencyMs = Number(arg('latency-ms', 0));
const budgetMs = Number(arg('budget-ms', 240000));
assert(Number.isInteger(rows) && rows >= 100 && rows <= 50000);
assert(Number.isInteger(concurrency) && concurrency >= 1 && concurrency <= 16);
assert(Number.isInteger(latencyMs) && latencyMs >= 0 && latencyMs <= 20);
assert(Number.isInteger(budgetMs) && budgetMs >= 100 && budgetMs <= 240000);
const client = new DynamoDBClient({
  endpoint: endpoint.href,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  maxAttempts: 1,
});
const raw = DynamoDBDocumentClient.from(client);
const tables = [];
const create = async (fields) => {
  const name = `repair-probe-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: fields.map((AttributeName, i) => ({
        AttributeName,
        KeyType: i ? 'RANGE' : 'HASH',
      })),
      AttributeDefinitions: fields.map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
    }),
  );
  tables.push(name);
  return name;
};
const seed = async (tableName, records) => {
  for (let i = 0; i < records.length; i += 25) {
    const result = await raw.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: records.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
    assert.deepEqual(result.UnprocessedItems, {});
  }
};
const observe = () => {
  const operations = {};
  const capacity = {};
  const sent = new Set();
  let outstanding = 0;
  let maxOutstanding = 0;
  const call = async (fn) => {
    outstanding++;
    maxOutstanding = Math.max(maxOutstanding, outstanding);
    try {
      if (latencyMs) await delay(latencyMs);
      return await fn();
    } finally {
      outstanding--;
    }
  };
  return {
    operations,
    capacity,
    sent,
    get maxOutstanding() {
      return maxOutstanding;
    },
    ddb: {
      send: (command, options) =>
        call(async () => {
          const name = command.constructor.name;
          operations[name] = (operations[name] ?? 0) + 1;
          command.input.ReturnConsumedCapacity = 'TOTAL';
          const result = await raw.send(command, options);
          capacity[name] = (capacity[name] ?? 0) + (result.ConsumedCapacity?.CapacityUnits ?? 0);
          return result;
        }),
    },
    sqs: {
      send: (command) =>
        call(async () => {
          operations.SendMessageCommand = (operations.SendMessageCommand ?? 0) + 1;
          sent.add(`${command.input.QueueUrl}:${command.input.MessageBody}`);
          return { MessageId: 'local-ack' };
        }),
    },
  };
};
const measure = async (factory, ports) => {
  const started = performance.now();
  const reports = [];
  const logger = {
    info: (value) => reports.push(JSON.parse(value)),
    warn: (value) => {
      throw Error(value);
    },
  };
  const results = [];
  do {
    assert(results.length < 1000, 'Probe continuation bound exceeded');
    results.push(await factory({ ...ports, logger })({ source: 'aws.events' }));
    assert.notEqual(results.at(-1).status, 'failed');
    assert.notEqual(results.at(-1).status, 'busy');
  } while (!results.at(-1).repaired);
  return {
    durationMs: Math.round(performance.now() - started),
    invocations: results.length,
    pages: results.reduce((n, r) => n + r.pages, 0),
    scanned: results.reduce((n, r) => n + r.scanned, 0),
    revocationLookups: results.reduce((n, r) => n + r.revocationLookups, 0),
    jobReads: results.reduce((n, r) => n + r.jobReads, 0),
    operations: ports.operations,
    localCapacityUnits: ports.capacity,
    uniqueHints: ports.sent.size,
    maxOutstanding: ports.maxOutstanding,
    finalStatus: results.at(-1).status,
  };
};
try {
  const tableName = await create(['pk', 'sk']);
  const checkpointTable = await create(['scope']);
  const count = Math.floor(rows / 100);
  const mix = {
    active: 2 * count,
    quiet: 2 * count,
    terminal: 2 * count,
    preparing: count,
    history: 80 * count,
    irrelevant: rows - 87 * count,
  };
  const records = Array.from({ length: rows }, (_, i) => {
    const scope = { projectId: 'probe', executionId: `execution-${i}` };
    const key = nativeRuntimeBindingKey(scope);
    const configuration = { image: { digest: `sha256:${String(i % 2).repeat(64)}` } };
    if (i < 6 * count)
      return {
        ...key,
        sk: 'EXECUTION',
        scope,
        status: i < 2 * count ? 'RUNNING' : i < 4 * count ? 'AWAITING_USER' : 'STOPPED',
        configuration,
      };
    if (i < 7 * count) return { ...key, ...scope, status: 'PREPARING' };
    return {
      ...key,
      sk:
        i < 87 * count
          ? `${['EVENT', 'OUTPUT', 'RESULT', 'PUBLICATION'][i % 4]}#${i}`
          : 'IRRELEVANT',
      status: 'RUNNING',
      payload: 'x'.repeat(2048),
    };
  });
  await seed(tableName, records);
  const runtimePorts = observe();
  const runtime = await measure(
    (ports) =>
      createNativeWakeupBridge({
        ...ports,
        tableName,
        checkpointTable,
        queues: {
          execution: 'execution',
          preparation: 'preparation',
          cancellation: 'cancellation',
          projection: 'projection',
        },
        repairOptions: { concurrency, budgetMs },
      }),
    runtimePorts,
  );
  assert.equal(runtime.uniqueHints, mix.active + mix.preparing);
  const packagesTable = await create(['projectId', 'jobId']);
  const jobs = createNativePackageJobs({
    ddb: raw,
    tableName: packagesTable,
    now: () => 1000,
    leaseMs: 100,
    maxAttempts: 3,
  });
  const busyJobs = createNativePackageJobs({
    ddb: raw,
    tableName: packagesTable,
    now: () => 1000,
    leaseMs: 60_000,
  });
  const packageCount = Math.min(200, count * 2);
  for (let i = 0; i < packageCount; i++) {
    const key = { projectId: 'probe', jobId: randomUUID() };
    await jobs.create({
      ...key,
      sourceId: 'a'.repeat(64),
      actorId: 'probe',
      bindingRevision: randomUUID(),
      requestedRelease: 'v2.9.0',
    });
    if (i % 4 === 1) await jobs.claim(key);
    if (i % 4 === 2) await busyJobs.claim(key);
    if (i % 4 === 3) {
      const claimed = await jobs.claim(key);
      await jobs.fail({
        ...key,
        leaseToken: claimed.job.leaseToken,
        code: 'native_package_worker_denied',
      });
    }
  }
  const packagePorts = observe();
  const packageStarted = performance.now();
  const packages = await measure(
    (ports) =>
      createNativePackageRepair({
        ...ports,
        tableName: packagesTable,
        checkpointTable,
        queueUrl: 'packages',
        // Trusted injected package clock: expired leases are eligible while
        // the independent busy group remains owned. Scan deadlines use the
        // same advancing clock; it never grants worker/source authority.
        now: () => 1101 + Math.floor(performance.now() - packageStarted),
        repairOptions: { concurrency, budgetMs },
      }),
    packagePorts,
  );
  assert.equal(
    packages.uniqueHints,
    Math.floor(packageCount / 4) * 2 + Math.min(packageCount % 4, 2),
  );
  console.log(
    JSON.stringify(
      {
        node: process.version,
        endpoint: endpoint.href,
        rows,
        historyPayloadBytes: 2048,
        mix,
        concurrency,
        injectedLatencyMsPerOperation: latencyMs,
        budgetMs,
        runtime,
        packageRows: packageCount,
        packageMix: 'repeating queued, expired lease, live lease, terminal denied',
        packages,
        interpretation:
          'Local service observations and explicit injected latency only; excludes schedule waits, provider work, AWS capacity/billing and production SLO qualification',
      },
      null,
      2,
    ),
  );
} finally {
  await Promise.all(tables.map((TableName) => client.send(new DeleteTableCommand({ TableName }))));
  client.destroy();
}
