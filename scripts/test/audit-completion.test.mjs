import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GetCommand, PutCommand, ScanCommand } from '@aws-sdk/lib-dynamodb';
import { main, readBudget } from '../audit-completion.mjs';

test('audit CLI fixtures run without AWS and resume within the same explicit scope', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'completion-audit-'));
  try {
    const fixture = path.join(dir, 'fixture.json');
    const output = path.join(dir, 'result.jsonl');
    const checkpoint = path.join(dir, 'checkpoint.json');
    const data = ['MERGED', 'BLOCKED'].map((state, i) => ({
      records: {
        meta: {
          projectId: 'project',
          executionId: `e${i}`,
          intentId: `e${i}`,
          orchestratorRunId: 'run',
          status: 'SUCCEEDED',
          startedAt: '2026-10-01T00:00:00.000Z',
          methodologyPins: { STAGE: { build: { tenantId: 'SYSTEM', version: 1 } } },
        },
        unitPlan: { units: [{ slug: 'unit' }] },
        units: [{ slug: 'unit', sectionIndex: 1, state }],
      },
      planResult: { valid: true, plan: { stages: [{ parallelSection: 1 }] } },
    }));
    await writeFile(fixture, JSON.stringify(data));
    const args = [
      '--fixture',
      fixture,
      '--output',
      output,
      '--checkpoint',
      checkpoint,
      '--project',
      'project',
      '--from',
      '2026-10-01T00:00:00.000Z',
      '--to',
      '2026-10-02T00:00:00.000Z',
      '--limit',
      '1',
    ];
    assert.equal(await main(args), 3);
    assert.equal(JSON.parse((await readFile(output, 'utf8')).split('\n')[0]).executionId, 'e0');
    await assert.rejects(
      main(args.map((arg) => (arg === fixture ? `${fixture}.different` : arg))),
      /checkpoint source differs/,
    );
    assert.equal(await main(args), 2);
    assert.equal(JSON.parse((await readFile(output, 'utf8')).split('\n')[0]).state, 'incomplete');
    assert.equal(JSON.parse(await readFile(checkpoint, 'utf8')), null);
    await assert.rejects(main(['--fixture', fixture]), /Explicit project/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('live client budget refuses writes, scans and unbounded reads', async () => {
  let calls = 0;
  const budget = readBudget(1);
  const client = budget.wrap({
    send: async () => {
      calls++;
      return {};
    },
  });
  assert.throws(() => client.send(new PutCommand({})), /targeted reads/);
  assert.throws(() => client.send(new ScanCommand({})), /targeted reads/);
  await client.send(new GetCommand({}));
  assert.throws(() => client.send(new GetCommand({})), /request limit/);
  assert.equal(calls, 1);
  assert.equal(budget.requests, 1);
  assert.equal(budget.exhausted, true);
});

// Exercise main, the real process store, output and checkpoint files through
// SDK-shaped clients. No credentials, AWS calls or production records.
const liveFixture = () => {
  const rows = ['e1', 'e2', 'e3', 'e4'].map((executionId) => ({
    pk: `EXEC#${executionId}`,
    sk: 'META',
    GSI1PK: 'PROJECT#project',
    GSI1SK: `STATUS#SUCCEEDED#STARTED#2026-10-01T00:00:00.000Z#${executionId}`,
    executionId,
    projectId: 'project',
    status: 'SUCCEEDED',
    startedAt: '2026-10-01T00:00:00.000Z',
  }));
  let accountId = '111111111111';
  const commands = [];
  const key = ({ pk, sk, GSI1PK, GSI1SK }) => ({ pk, sk, GSI1PK, GSI1SK });
  const createClients = async () => ({
    sts: {
      send: async (command) => {
        commands.push(command);
        return { Account: accountId };
      },
    },
    ddb: {
      send: async (command) => {
        commands.push(command);
        const input = command.input;
        if (command.constructor.name === 'GetCommand') {
          return { Item: rows.find((row) => row.pk === input.Key.pk && row.sk === input.Key.sk) };
        }
        assert.equal(command.constructor.name, 'QueryCommand');
        if (!input.IndexName) return { Items: [] };
        const start = input.ExclusiveStartKey
          ? rows.findIndex((row) => row.pk === input.ExclusiveStartKey.pk) + 1
          : 0;
        const items = rows.slice(start, start + input.Limit);
        return {
          Items: items,
          LastEvaluatedKey: start + items.length < rows.length ? key(items.at(-1)) : undefined,
        };
      },
    },
    s3: { send: async () => assert.fail('Serial records do not load a plan') },
  });
  return {
    createClients,
    commands,
    setAccount: (id) => {
      accountId = id;
    },
  };
};
const liveArgs = (dir, maxRequests = 20) => [
  '--region',
  'eu-central-1',
  '--table',
  'process',
  '--blocks-table',
  'blocks',
  '--project',
  'project',
  '--from',
  '2026-10-01T00:00:00.000Z',
  '--to',
  '2026-10-02T00:00:00.000Z',
  '--max-requests',
  String(maxRequests),
  '--checkpoint',
  path.join(dir, 'checkpoint.json'),
  '--output',
  path.join(dir, 'result.jsonl'),
];
const readResult = async (dir) =>
  (await readFile(path.join(dir, 'result.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);

for (const pageSize of [2, 4]) {
  test(`budget exhaustion resumes every unprocessed intent with page size ${pageSize}`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'completion-budget-'));
    try {
      const fixture = liveFixture();
      const args = [...liveArgs(dir), '--page-size', String(pageSize)];
      assert.equal(await main(args, fixture), 3);
      const first = await readResult(dir);
      assert.deepEqual(
        first.slice(0, -1).map((f) => f.executionId),
        ['e1', 'e2'],
      );
      assert.equal(first.at(-1).metrics.examined, 2);
      assert.equal(first.at(-1).metrics.unknown, 0);
      assert.equal(first.at(-1).finished, false);
      assert.equal(first.at(-1).discoveryUnverified, false);
      assert.equal(first.at(-1).stopReason, 'budget_exhausted');
      assert.equal(first.at(-1).requests, 20);
      assert.equal(fixture.commands.length, 20);
      const saved = JSON.parse(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'));
      assert.equal(saved.audit.cursor.pk, 'EXEC#e2');
      assert.equal(saved.source.accountId, '111111111111');
      assert.equal(await main(args, fixture), 0);
      const second = await readResult(dir);
      assert.deepEqual(
        second.slice(0, -1).map((f) => f.executionId),
        ['e3', 'e4'],
      );
      assert.equal(second.at(-1).finished, true);
      assert.equal(JSON.parse(await readFile(path.join(dir, 'checkpoint.json'), 'utf8')), null);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

for (const maxRequests of [1, 2, 16, 30]) {
  test(`budget boundary ${maxRequests} never exceeds the cap or loses a candidate`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'completion-boundary-'));
    try {
      const fixture = liveFixture();
      const exit = await main(liveArgs(dir, maxRequests), fixture);
      const result = await readResult(dir);
      const summary = result.at(-1);
      assert.equal(fixture.commands.length, maxRequests);
      assert.equal(summary.requests, maxRequests);
      assert.equal(exit, maxRequests === 30 ? 0 : 3);
      assert.equal(summary.budgetExhausted, maxRequests !== 30);
      if (maxRequests <= 2) {
        assert.equal(summary.metrics.examined, 0);
        const saved = JSON.parse(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'));
        assert.equal(saved.audit.cursor, null);
      }
      if (maxRequests !== 30) {
        assert.equal(await main(liveArgs(dir, 30), fixture), 0);
        const resumed = await readResult(dir);
        assert.deepEqual(
          [...result.slice(0, -1), ...resumed.slice(0, -1)].map((f) => f.executionId),
          ['e1', 'e2', 'e3', 'e4'],
        );
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}

test('live checkpoints reject a different account before data reads and preserve the file', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'completion-account-'));
  try {
    const fixture = liveFixture();
    const args = liveArgs(dir);
    assert.equal(await main(args, fixture), 3);
    const before = await readFile(path.join(dir, 'checkpoint.json'), 'utf8');
    const reads = fixture.commands.length;
    fixture.setAccount('222222222222');
    await assert.rejects(main(args, fixture), /checkpoint source differs/);
    assert.equal(fixture.commands.length, reads + 1); // identity only
    assert.equal(await readFile(path.join(dir, 'checkpoint.json'), 'utf8'), before);
    fixture.setAccount('111111111111');
    assert.equal(await main([...args, '--profile', 'another-profile-same-account'], fixture), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing account identity cannot start discovery', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'completion-identity-'));
  try {
    const fixture = liveFixture();
    fixture.setAccount(undefined);
    await assert.rejects(main(liveArgs(dir), fixture), /verify the AWS account/);
    assert.equal(fixture.commands.length, 1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('checkpoint saving waits for output and does not advance after an output failure', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'completion-output-'));
  try {
    const fixture = liveFixture();
    const args = liveArgs(dir).slice(0, -2); // stdout instead of --output
    let finishOutput;
    let outputStarted;
    const started = new Promise((resolve) => {
      outputStarted = resolve;
    });
    const pending = main(args, {
      ...fixture,
      stdout: {
        write: (_text, done) => {
          finishOutput = done;
          outputStarted();
        },
      },
    });
    await started;
    const checkpoint = path.join(dir, 'checkpoint.json');
    await assert.rejects(readFile(checkpoint), { code: 'ENOENT' });
    finishOutput();
    assert.equal(await pending, 3);
    const before = await readFile(checkpoint, 'utf8');
    await assert.rejects(
      main(args, {
        ...fixture,
        stdout: { write: (_text, done) => done(new Error('output failed')) },
      }),
      /output failed/,
    );
    assert.equal(await readFile(checkpoint, 'utf8'), before);
    assert.equal(await main(liveArgs(dir), fixture), 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('concurrent and rejected reads share one strict budget across clients', async () => {
  const budget = readBudget(2);
  let calls = 0;
  const client = {
    send: async () => {
      calls++;
      throw new Error('read failed');
    },
  };
  const ddb = budget.wrap(client);
  const s3 = budget.wrap(client);
  const results = await Promise.allSettled(
    [ddb, s3, ddb, s3].map(async (bounded) => bounded.send(new GetCommand({}))),
  );
  assert.equal(results.filter((r) => r.status === 'rejected').length, 4);
  assert.equal(calls, 2);
  assert.equal(budget.requests, 2);
  assert.equal(budget.exhausted, true);
});

for (const status of ['CANCELLED', 'FAILED']) {
  test(`audit CLI --status ${status} counts unpinned aborted work and exits zero`, async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'completion-aborted-'));
    try {
      const fixture = path.join(dir, 'fixture.json');
      const output = path.join(dir, 'result.jsonl');
      await writeFile(
        fixture,
        JSON.stringify([
          {
            records: {
              meta: {
                projectId: 'project',
                executionId: 'aborted',
                orchestratorRunId: 'run',
                status,
                startedAt: '2026-10-01T00:00:00.000Z',
                ...(status === 'FAILED' ? { failure: { code: 'section_aborted' } } : {}),
              },
              unitPlan: { units: [{ slug: 'unit' }] },
              units: [{ slug: 'unit', sectionIndex: 1, state: 'PENDING' }],
              humanTasks:
                status === 'FAILED'
                  ? [{ orchestratorRunId: 'run', status: 'answered', answer: 'abort' }]
                  : [],
            },
            planResult: { valid: false },
          },
        ]),
      );
      const exit = await main([
        '--fixture',
        fixture,
        '--output',
        output,
        '--project',
        'project',
        '--from',
        '2026-10-01T00:00:00.000Z',
        '--to',
        '2026-10-02T00:00:00.000Z',
        '--status',
        status,
      ]);
      const [finding, summary] = (await readFile(output, 'utf8'))
        .trim()
        .split('\n')
        .map(JSON.parse);
      assert.equal(exit, 0);
      assert.equal(finding.state, 'aborted');
      assert.equal(finding.integrated, 0);
      assert.equal(finding.total, 1);
      assert.equal(summary.metrics.aborted, 1);
      assert.equal(summary.metrics.unknown, 0);
      assert.equal(summary.metrics.complete, 0);
      assert.equal(summary.finished, true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
}
