import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  MAX_RETRIES,
  MAX_SCAN_PAGES,
  OVERRIDE_ENV,
  isRetryable,
  parseArgs,
  runPreflight,
  targetFromPlan,
} from '../notifications-preflight.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const TABLE = 'aidlc-notifications-dev';
const LEGACY_ROW = { userId: { S: 'user-with-private-email@example.com' }, timestamp: { N: '1' } };

const awsError = (name, status = 400) =>
  Object.assign(new Error(`${name} from AWS`), { name, $metadata: { httpStatusCode: status } });

// Captures every line so tests can assert nothing about item contents leaks.
const captureLog = () => {
  const lines = [];
  const push = (...parts) => lines.push(parts.join(' '));
  return { lines, log: { log: push, warn: push, error: push }, text: () => lines.join('\n') };
};

const fakeClient = ({ describe, scans = [] }) => {
  const calls = { describe: 0, scan: [] };
  return {
    calls,
    describeTable: async () => {
      calls.describe += 1;
      return typeof describe === 'function' ? describe(calls.describe) : describe;
    },
    scanOne: async (tableName, startKey) => {
      calls.scan.push(startKey);
      const next = scans[Math.min(calls.scan.length - 1, scans.length - 1)];
      return typeof next === 'function' ? next(calls.scan.length) : next;
    },
  };
};

const preflight = (client, env = {}) => {
  const output = captureLog();
  const sleeps = [];
  return runPreflight({
    tableName: TABLE,
    client,
    env,
    log: output.log,
    sleep: async (ms) => sleeps.push(ms),
    random: () => 1,
  }).then((result) => ({ ...result, output, sleeps }));
};

const legacyTable = { TableName: TABLE, GlobalSecondaryIndexes: undefined };

test('T1: a missing table is a fresh install and passes', async () => {
  const client = fakeClient({
    describe: () => {
      throw awsError('ResourceNotFoundException');
    },
  });
  const result = await preflight(client);
  assert.deepEqual([result.outcome, result.exitCode], ['fresh', 0]);
  assert.equal(client.calls.scan.length, 0);
});

test('T2: SourceIndex marks the table as already upgraded and skips the scan', async () => {
  const client = fakeClient({
    describe: { GlobalSecondaryIndexes: [{ IndexName: 'SourceIndex' }] },
    scans: [{ Count: 1, Items: [LEGACY_ROW] }],
  });
  const result = await preflight(client);
  assert.deepEqual([result.outcome, result.exitCode], ['already-upgraded', 0]);
  assert.equal(client.calls.scan.length, 0);
});

test('T2: a partial apply that only created SourceIndex still passes', async () => {
  const client = fakeClient({
    describe: { GlobalSecondaryIndexes: [{ IndexName: 'SourceIndex' }] },
  });
  assert.equal((await preflight(client)).exitCode, 0);
});

test('T3: an empty table passes, including empty pages before the end', async () => {
  const client = fakeClient({
    describe: legacyTable,
    scans: [{ Count: 0, LastEvaluatedKey: { userId: { S: 'a' } } }, { Count: 0 }],
  });
  const result = await preflight(client);
  assert.deepEqual([result.outcome, result.exitCode], ['empty', 0]);
  assert.deepEqual(client.calls.scan, [undefined, { userId: { S: 'a' } }]);
});

test('T4: a legacy row halts with guidance and never prints item contents', async () => {
  const client = fakeClient({ describe: legacyTable, scans: [{ Count: 1, Items: [LEGACY_ROW] }] });
  const result = await preflight(client);
  assert.deepEqual([result.outcome, result.exitCode], ['legacy-present', 1]);
  const text = result.output.text();
  assert.match(text, /notifications-preflight: HALT/);
  assert.match(text, new RegExp(TABLE));
  assert.match(text, /AIDLC_NOTIFICATIONS_PREFLIGHT=acknowledge-legacy/);
  assert.match(text, /Back up the table/);
  assert.doesNotMatch(text, /user-with-private-email/);
  for (const line of result.output.lines) assert.match(line, /^notifications-preflight:/);
});

test('T4: an unrecognised override value is ignored with a hint', async () => {
  const client = fakeClient({ describe: legacyTable, scans: [{ Count: 1 }] });
  const result = await preflight(client, { [OVERRIDE_ENV]: 'yes' });
  assert.equal(result.exitCode, 1);
  assert.match(result.output.text(), /only accepted value is "acknowledge-legacy"/);
});

test('T5: the acknowledge-legacy override warns and passes', async () => {
  const client = fakeClient({ describe: legacyTable, scans: [{ Count: 1, Items: [LEGACY_ROW] }] });
  const result = await preflight(client, { [OVERRIDE_ENV]: 'acknowledge-legacy' });
  assert.deepEqual([result.outcome, result.exitCode], ['legacy-acknowledged', 0]);
  assert.match(result.output.text(), /WARN — legacy rows left/);
  assert.doesNotMatch(result.output.text(), /user-with-private-email/);
});

test('T6: AccessDenied halts even with the override and is not retried', async () => {
  const client = fakeClient({
    describe: () => {
      throw awsError('AccessDeniedException', 400);
    },
  });
  const result = await preflight(client, { [OVERRIDE_ENV]: 'acknowledge-legacy' });
  assert.deepEqual([result.outcome, result.exitCode], ['unverifiable', 1]);
  assert.equal(client.calls.describe, 1);
  assert.match(result.output.text(), /cannot verify/);
});

test('T6: AccessDenied on the scan also fails closed despite the override', async () => {
  const client = fakeClient({
    describe: legacyTable,
    scans: [
      () => {
        throw awsError('AccessDeniedException');
      },
    ],
  });
  const result = await preflight(client, { [OVERRIDE_ENV]: 'acknowledge-legacy' });
  assert.equal(result.outcome, 'unverifiable');
});

test('T6: throttling is retried with backoff, then halts when retries run out', async () => {
  const client = fakeClient({
    describe: () => {
      throw awsError('ThrottlingException');
    },
  });
  const result = await preflight(client);
  assert.deepEqual([result.outcome, result.exitCode], ['unverifiable', 1]);
  assert.equal(client.calls.describe, MAX_RETRIES + 1);
  assert.deepEqual(result.sleeps, [200, 400, 800]);
});

test('T6: a transient 5xx recovers within the retry budget', async () => {
  const client = fakeClient({
    describe: (call) => {
      if (call < 3) throw awsError('InternalServerError', 500);
      return legacyTable;
    },
    scans: [{ Count: 0 }],
  });
  const result = await preflight(client);
  assert.deepEqual([result.outcome, client.calls.describe], ['empty', 3]);
});

test('exhausting the scan page budget is treated as non-empty', async () => {
  const client = fakeClient({
    describe: legacyTable,
    scans: [{ Count: 0, LastEvaluatedKey: { userId: { S: 'next' } } }],
  });
  const result = await preflight(client);
  assert.equal(result.outcome, 'legacy-present');
  assert.equal(client.calls.scan.length, MAX_SCAN_PAGES);
});

test('only throttling, 5xx and network failures are retryable', () => {
  assert.equal(isRetryable(awsError('ProvisionedThroughputExceededException')), true);
  assert.equal(isRetryable(awsError('ServiceUnavailable', 503)), true);
  assert.equal(isRetryable(Object.assign(new Error('reset'), { code: 'ECONNRESET' })), true);
  assert.equal(isRetryable(awsError('ValidationException')), false);
  assert.equal(isRetryable(awsError('UnrecognizedClientException')), false);
  assert.equal(isRetryable(awsError('AccessDeniedException', 403)), false);
});

test('the saved plan supplies the table name and region', () => {
  const plan = {
    variables: {
      project_name: { value: 'aidlc' },
      environment: { value: 'dev' },
      aws_region: { value: 'eu-west-1' },
    },
    resource_changes: [
      {
        address: 'module.dynamodb.aws_dynamodb_table.notifications',
        change: { actions: ['update'], after: { name: 'custom-notifications-dev' } },
      },
    ],
  };
  assert.deepEqual(targetFromPlan(plan), {
    tableName: 'custom-notifications-dev',
    region: 'eu-west-1',
  });
  assert.deepEqual(targetFromPlan({ ...plan, resource_changes: [] }), {
    tableName: 'aidlc-notifications-dev',
    region: 'eu-west-1',
  });
  assert.throws(() => targetFromPlan({ variables: {} }), /does not identify/);
});

test('argument parsing requires a table and region or a plan', () => {
  assert.deepEqual(parseArgs(['--table', 't', '--region', 'r']), { tableName: 't', region: 'r' });
  assert.throws(() => parseArgs(['--table', 't']), /expected --table and --region/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /unexpected argument/);
});

test('the CLI exits 2 on usage errors without calling AWS', () => {
  const result = spawnSync(process.execPath, [join(root, 'scripts/notifications-preflight.mjs')], {
    encoding: 'utf8',
  });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /Usage: notifications-preflight\.mjs/);

  const dir = mkdtempSync(join(tmpdir(), 'aidlc-preflight-cli-'));
  try {
    const planJson = join(dir, 'plan.json');
    writeFileSync(planJson, '{"variables":{}}');
    const fromPlan = spawnSync(
      process.execPath,
      [join(root, 'scripts/notifications-preflight.mjs'), '--plan-json', planJson],
      { encoding: 'utf8' },
    );
    assert.equal(fromPlan.status, 2);
    assert.match(fromPlan.stderr, /does not identify the notifications table/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
