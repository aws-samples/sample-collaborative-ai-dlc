import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { CreateTableCommand, DeleteTableCommand, DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from '@aws-sdk/lib-dynamodb';
import { createNativeRepairScan } from '../native-repair-scan.js';
import { createNativePackageJobs } from '../native-package-jobs.js';
import { nativeRuntimeBindingKey } from '../native-runtime-binding.js';
import { createNativeWakeupBridge } from '../../native-runtime-control/wakeup.js';
import { createNativePackageRepair } from '../../native-package-worker/repair.js';
import { createNativePackageWorker } from '../../native-package-worker/worker.js';
import {
  candidate,
  receipt,
  SOURCE,
  REVISION,
} from '../../native-runtime-control/test/fixtures.js';

const client = new DynamoDBClient({
  endpoint: process.env.DYNAMODB_LOCAL_ENDPOINT,
  region: 'us-east-1',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  maxAttempts: 1,
});
const ddb = DynamoDBDocumentClient.from(client);
const tables = [];
const logger = { info: vi.fn(), warn: vi.fn() };
const table = async (keys) => {
  if (!process.env.DYNAMODB_LOCAL_ENDPOINT?.startsWith('http://'))
    throw Error('Local DynamoDB endpoint required');
  const name = `repair-${randomUUID()}`;
  await client.send(
    new CreateTableCommand({
      TableName: name,
      BillingMode: 'PAY_PER_REQUEST',
      KeySchema: keys.map((AttributeName, i) => ({ AttributeName, KeyType: i ? 'RANGE' : 'HASH' })),
      AttributeDefinitions: keys.map((AttributeName) => ({ AttributeName, AttributeType: 'S' })),
    }),
  );
  tables.push(name);
  return name;
};
const seed = async (tableName, rows) => {
  for (let i = 0; i < rows.length; i += 25) {
    const result = await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [tableName]: rows.slice(i, i + 25).map((Item) => ({ PutRequest: { Item } })),
        },
      }),
    );
    expect(result.UnprocessedItems).toEqual({});
  }
};
const runtime = (i, extra = {}) => {
  const scope = { projectId: 'project', executionId: `execution-${i}` };
  return {
    ...nativeRuntimeBindingKey(scope),
    sk: 'EXECUTION',
    scope,
    status: 'RUNNING',
    configuration: { image: { digest: `sha256:${'a'.repeat(64)}` } },
    ...extra,
  };
};
afterAll(async () => {
  await Promise.all(tables.map((TableName) => client.send(new DeleteTableCommand({ TableName }))));
  client.destroy();
});

describe('repair checkpoints on real DynamoDB', () => {
  it('coalesces revocation bursts, retries partial stream failure and preserves pending cancellation on lookup failure', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    await seed(tableName, [runtime(0, { status: 'CANCEL_REQUESTED' })]);
    let fail = true;
    let scans = 0;
    const wrapped = {
      send: async (c, opts) => {
        if (c instanceof ScanCommand) scans++;
        if (fail && c instanceof GetCommand && c.input.Key.sk === 'REVOCATION')
          throw Error('lookup throttled');
        return ddb.send(c, opts);
      },
    };
    const sqs = { send: vi.fn(async () => ({ MessageId: 'ack' })) };
    const event = {
      Records: ['a', 'b'].map((digit, i) => ({
        dynamodb: {
          SequenceNumber: String(i + 1),
          NewImage: {
            pk: { S: `NATIVE_RUNTIME_IMAGE#sha256:${digit.repeat(64)}` },
            sk: { S: 'REVOCATION' },
          },
        },
      })),
    };
    const run = createNativeWakeupBridge({
      ddb: wrapped,
      sqs,
      tableName,
      checkpointTable,
      queues: { cancellation: 'urgent' },
      logger,
    });
    expect(await run(event)).toEqual({
      batchItemFailures: [{ itemIdentifier: '1' }, { itemIdentifier: '2' }],
    });
    expect(scans).toBe(1);
    expect(sqs.send).toHaveBeenCalledTimes(1);
    fail = false;
    expect(await run(event)).toEqual({ batchItemFailures: [] });
    expect(scans).toBe(2);
  });

  it('crosses the real 1 MiB scan boundary with history and never schedules result rows', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    const rows = Array.from({ length: 130 }, (_, i) => ({
      ...runtime(i),
      sk: i % 2 ? `OUTPUT#${i}` : `RESULT#${i}`,
      payload: 'x'.repeat(12_000),
    }));
    await seed(tableName, [...rows, runtime(999)]);
    const sent = [];
    const result = await createNativeWakeupBridge({
      ddb,
      sqs: {
        send: async (c) => {
          sent.push(c.input.MessageBody);
          return { MessageId: 'ack' };
        },
      },
      tableName,
      checkpointTable,
      queues: { execution: 'local' },
      logger,
      repairOptions: { pageSize: 1000 },
    })({ source: 'aws.events' });
    expect(result).toMatchObject({ repaired: true, scanned: 131, sends: 1 });
    expect(result.pages).toBeGreaterThan(1);
    expect(JSON.parse(sent[0]).executionId).toBe('execution-999');
  });

  it('does not let an ordinary send failure block revoked-image cancellation or the tail', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    const digest = runtime(0).configuration.image.digest;
    await seed(tableName, [
      runtime(0),
      runtime(1),
      { pk: `NATIVE_RUNTIME_IMAGE#${digest}`, sk: 'REVOCATION' },
    ]);
    const cancellation = new Set();
    const result = await createNativeWakeupBridge({
      ddb,
      sqs: {
        send: async (c) => {
          if (c.input.QueueUrl === 'execution') throw Error('queue unavailable');
          cancellation.add(JSON.parse(c.input.MessageBody).executionId);
          return { MessageId: 'ack' };
        },
      },
      tableName,
      checkpointTable,
      queues: { execution: 'execution', cancellation: 'urgent' },
      logger,
    })({ source: 'aws.events' });
    expect(result).toMatchObject({ repaired: false, errors: 2 });
    expect([...cancellation].sort()).toEqual(['execution-0', 'execution-1']);
  });

  it('recovers a committed checkpoint with a lost acknowledgement without claiming success', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    await seed(
      tableName,
      Array.from({ length: 5 }, (_, i) => ({ pk: `key-${i}`, sk: 'work' })),
    );
    let clock = 1000;
    let lose = true;
    const seen = new Set();
    const wrapped = {
      send: async (c, opts) => {
        const result = await ddb.send(c, opts);
        if (lose && c instanceof PutCommand && c.input.Item.cursor) {
          lose = false;
          throw Error('acknowledgement lost');
        }
        return result;
      },
    };
    const args = {
      ddb: wrapped,
      tableName,
      checkpointTable,
      scope: 'runtime',
      keyFields: ['pk', 'sk'],
      now: () => clock,
      logger,
      concurrency: 1,
      visit: async (row) => {
        seen.add(row.pk);
      },
    };
    await expect(createNativeRepairScan(args)()).rejects.toThrow('acknowledgement lost');
    expect(seen.size).toBe(1);
    clock += 960001;
    expect((await createNativeRepairScan(args)()).repaired).toBe(true);
    expect(seen.size).toBe(5);
  });

  it('reloads package eligibility after a concurrent terminal transition instead of trusting scan data', async () => {
    const tableName = await table(['projectId', 'jobId']);
    const checkpointTable = await table(['scope']);
    const jobs = createNativePackageJobs({ ddb, tableName });
    const key = { projectId: 'project', jobId: randomUUID() };
    await jobs.create({
      ...key,
      sourceId: SOURCE.sourceId,
      actorId: 'member',
      bindingRevision: REVISION,
    });
    let changed = false;
    const wrapped = {
      send: async (c, opts) => {
        const result = await ddb.send(c, opts);
        if (c instanceof ScanCommand && !changed) {
          changed = true;
          const claimed = await jobs.claim(key);
          await jobs.fail({
            ...key,
            leaseToken: claimed.job.leaseToken,
            code: 'native_package_worker_denied',
          });
        }
        return result;
      },
    };
    const send = vi.fn();
    const result = await createNativePackageRepair({
      ddb: wrapped,
      sqs: { send },
      tableName,
      checkpointTable,
      queueUrl: 'local',
      logger,
    })({ source: 'aws.events' });
    expect(result).toMatchObject({ repaired: true, sends: 0, jobReads: 1 });
    expect(send).not.toHaveBeenCalled();
  });

  it('resumes within a page across deadlines, preserves tail fairness and retries failed/unacknowledged sends', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    await seed(
      tableName,
      Array.from({ length: 31 }, (_, i) => runtime(i)),
    );
    let clock = 1000;
    let fail = true;
    const seen = new Set();
    const sqs = {
      send: async (c) => {
        const pointer = JSON.parse(c.input.MessageBody);
        clock += 5;
        if (fail && pointer.executionId === 'execution-0') return {};
        seen.add(pointer.executionId);
        return { MessageId: 'ack' };
      },
    };
    const run = () =>
      createNativeWakeupBridge({
        ddb,
        sqs,
        tableName,
        checkpointTable,
        queues: { execution: 'local' },
        logger,
        repairOptions: { now: () => clock, budgetMs: 46, concurrency: 2, pageSize: 20 },
      })({ source: 'aws.events' });
    let result;
    let continued = 0;
    do {
      result = await run();
      if (result.status === 'continued') continued++;
    } while (result.status === 'continued' && continued < 20);
    expect(result).toMatchObject({ status: 'failed', repaired: false });
    expect(continued).toBeGreaterThan(1);
    expect(seen.size).toBe(30);
    fail = false;
    do {
      result = await run();
    } while (result.status === 'continued');
    expect(result.repaired).toBe(true);
    expect(seen.size).toBe(31);
  });

  it('excludes concurrent scanners and resumes after scan failure and lease expiry without changing source rows', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    const rows = Array.from({ length: 9 }, (_, i) => ({ pk: `key-${i}`, sk: 'work' }));
    await seed(tableName, rows);
    let clock = 1000;
    let unblock;
    const blocked = new Promise((resolve) => {
      unblock = resolve;
    });
    let entered;
    const ready = new Promise((resolve) => {
      entered = resolve;
    });
    let once = true;
    const visited = new Set();
    const args = {
      ddb,
      tableName,
      checkpointTable,
      scope: 'runtime',
      keyFields: ['pk', 'sk'],
      now: () => clock,
      logger,
      pageSize: 3,
      visit: async (row) => {
        visited.add(row.pk);
        if (once) {
          once = false;
          entered();
          await blocked;
        }
      },
    };
    const first = createNativeRepairScan(args)();
    await ready;
    expect(await createNativeRepairScan(args)()).toMatchObject({ status: 'busy', repaired: false });
    unblock();
    expect((await first).repaired).toBe(true);
    const broken = {
      send: (command) => {
        if (command instanceof ScanCommand) throw Error('throttled');
        return ddb.send(command);
      },
    };
    await expect(createNativeRepairScan({ ...args, ddb: broken })()).rejects.toThrow('throttled');
    expect((await createNativeRepairScan(args)()).status).toBe('busy');
    clock += 960001;
    expect((await createNativeRepairScan(args)()).repaired).toBe(true);
    expect(visited.size).toBe(9);
    expect((await ddb.send(new ScanCommand({ TableName: tableName }))).Items).toHaveLength(9);
  });

  it('fences a stale checkpoint writer and rejects a foreign source cursor', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    await seed(tableName, [{ pk: 'one', sk: 'work' }]);
    let clock = 1000;
    let unblock;
    let entered;
    const ready = new Promise((r) => {
      entered = r;
    });
    const held = new Promise((r) => {
      unblock = r;
    });
    const args = {
      ddb,
      tableName,
      checkpointTable,
      scope: 'runtime',
      keyFields: ['pk', 'sk'],
      now: () => clock,
      logger,
    };
    const first = createNativeRepairScan({
      ...args,
      visit: async () => {
        entered();
        await held;
      },
    })();
    await ready;
    clock += 960001;
    expect((await createNativeRepairScan({ ...args, visit: async () => {} })()).repaired).toBe(
      true,
    );
    unblock();
    await expect(first).rejects.toThrow();
    const state = (
      await ddb.send(new GetCommand({ TableName: checkpointTable, Key: { scope: 'runtime' } }))
    ).Item;
    await ddb.send(
      new PutCommand({ TableName: checkpointTable, Item: { ...state, sourceTable: 'foreign' } }),
    );
    await expect(createNativeRepairScan({ ...args, visit: async () => {} })()).rejects.toThrow(
      'checkpoint invalid',
    );
  });

  it('reads a digest once per page, discovers concurrent revocation next sweep, and rejects mismatched scopes', async () => {
    const tableName = await table(['pk', 'sk']);
    const checkpointTable = await table(['scope']);
    await seed(
      tableName,
      Array.from({ length: 10 }, (_, i) => runtime(i, { status: 'AWAITING_USER' })),
    );
    let revoke = true;
    const digest = runtime(0).configuration.image.digest;
    const wrapped = {
      send: async (c, options) => {
        const result = await ddb.send(c, options);
        if (revoke && c instanceof GetCommand && c.input.Key.sk === 'REVOCATION') {
          revoke = false;
          await seed(tableName, [{ pk: `NATIVE_RUNTIME_IMAGE#${digest}`, sk: 'REVOCATION' }]);
        }
        return result;
      },
    };
    const sqs = { send: vi.fn(async () => ({ MessageId: 'ack' })) };
    const run = () =>
      createNativeWakeupBridge({
        ddb: wrapped,
        sqs,
        tableName,
        checkpointTable,
        queues: { cancellation: 'urgent' },
        logger,
      })({ source: 'aws.events' });
    const first = await run();
    expect(first.revocationLookups).toBe(1);
    expect(sqs.send).not.toHaveBeenCalled();
    expect((await run()).sends).toBe(10);
    await seed(tableName, [runtime(999, { pk: 'FOREIGN', status: 'RUNNING' })]);
    expect(await run()).toMatchObject({ repaired: false, errors: 1 });
    expect(sqs.send.mock.calls.every(([c]) => c.input.QueueUrl === 'urgent')).toBe(true);
  });

  it('repairs package delivery after lost queue/stream retention with fenced immutable recovery and attempt exhaustion', async () => {
    const tableName = await table(['projectId', 'jobId']);
    const checkpointTable = await table(['scope']);
    let clock = 1000;
    const jobs = createNativePackageJobs({
      ddb,
      tableName,
      now: () => clock,
      leaseMs: 100,
      maxAttempts: 2,
    });
    const make = async () => {
      const key = { projectId: candidate().projectId, jobId: randomUUID() };
      await jobs.create({
        ...key,
        sourceId: SOURCE.sourceId,
        actorId: 'member',
        bindingRevision: REVISION,
      });
      return key;
    };
    const pinned = await make();
    const first = await jobs.claim(pinned);
    const lease = { ...pinned, leaseToken: first.job.leaseToken };
    await jobs.saveCandidate({ ...lease, candidate: candidate() });
    await jobs.saveReceipt({ ...lease, receipt: receipt() });
    const terminal = await make();
    const denied = await jobs.claim(terminal);
    await jobs.fail({
      ...terminal,
      leaseToken: denied.job.leaseToken,
      code: 'native_package_worker_denied',
    });
    const exhausted = await make();
    await jobs.claim(exhausted);
    clock += 101;
    await jobs.claim(exhausted);
    clock += 101;
    const busy = await make();
    await jobs.claim(busy);
    const messages = [];
    const repair = createNativePackageRepair({
      ddb,
      sqs: {
        send: async (c) => {
          messages.push(JSON.parse(c.input.MessageBody));
          return { MessageId: 'ack' };
        },
      },
      tableName,
      checkpointTable,
      queueUrl: 'local',
      now: () => clock,
      logger,
    });
    expect((await repair({ source: 'aws.events' })).sends).toBe(2);
    expect(messages.map((p) => p.jobId).sort()).toEqual([pinned.jobId, exhausted.jobId].sort());
    const load = vi.fn();
    const prepare = vi.fn(() => {
      throw Error('must never rediscover latest');
    });
    const worker = createNativePackageWorker({
      jobs,
      expectedQueueArn: 'arn:aws:sqs:us-east-1:123456789012:local',
      now: () => clock,
      createAttempt: async () => ({
        intake: { prepare, recoverPreparation: prepare, loadPinned: load },
        cleanup: async () => {},
        authorizeCompletion: async () => {},
        finish: async () => {},
      }),
    });
    const event = {
      Records: messages.map((p, i) => ({
        eventSource: 'aws:sqs',
        eventSourceARN: 'arn:aws:sqs:us-east-1:123456789012:local',
        messageId: `message-${i}`,
        body: JSON.stringify(p),
      })),
    };
    expect(await worker(event)).toEqual({ batchItemFailures: [] });
    expect(await worker(event)).toEqual({ batchItemFailures: [] });
    expect(load).toHaveBeenCalledTimes(1);
    expect(prepare).not.toHaveBeenCalled();
    expect(await jobs.get(pinned)).toMatchObject({
      state: 'SUCCEEDED',
      attempts: 2,
      candidate: candidate(),
      archiveReceipt: receipt(),
    });
    expect(await jobs.get(exhausted)).toMatchObject({
      state: 'FAILED',
      errorCode: 'native_package_job_attempts_exhausted',
    });
    expect((await jobs.get(terminal)).errorCode).toBe('native_package_worker_denied');
    await expect(jobs.succeed(lease)).rejects.toMatchObject({
      code: 'native_package_job_lease_lost',
    });
  });
});
