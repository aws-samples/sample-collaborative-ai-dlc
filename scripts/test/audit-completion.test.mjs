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
  const client = readBudget(1)({
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
