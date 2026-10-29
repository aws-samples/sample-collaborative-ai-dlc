import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { captureContext, collectReviewSignals } from '../pr-impact/collect.mjs';

const metadata = {
  schemaVersion: 1,
  repository: 'aws-samples/sample-collaborative-ai-dlc',
  prNumber: 582,
  headSha: 'a'.repeat(40),
  baseSha: 'b'.repeat(40),
  baseRef: 'main',
  controllerSha: 'c'.repeat(40),
  runId: 123,
  runAttempt: 1,
  headRepositoryId: 456,
};
const mergeBase = 'd'.repeat(40);
function qualityReport(measured = false) {
  const coverage = measured
    ? { status: 'measured', total: 1, covered: 1, uncovered: 0, percent: 100 }
    : { status: 'unknown' };
  return {
    schemaVersion: 1,
    base: metadata.baseSha,
    baseRef: metadata.baseRef,
    mergeBase,
    pr: metadata.headSha,
    analyzer: { threshold: 15 },
    coverageNotes: [],
    files: [
      {
        path: 'lambda/example/index.js',
        before: [{ name: 'example', line: 1, score: 17, coverage }],
        after: [{ name: 'example', line: 1, score: 18, coverage }],
      },
    ],
    findings: [],
    improvements: [],
  };
}
const event = {
  number: metadata.prNumber,
  repository: { full_name: metadata.repository },
  pull_request: {
    head: { sha: metadata.headSha, repo: { id: metadata.headRepositoryId } },
    base: {
      sha: metadata.baseSha,
      ref: metadata.baseRef,
      repo: { full_name: metadata.repository },
    },
  },
};
const environment = {
  GITHUB_EVENT_NAME: 'pull_request_target',
  GITHUB_REPOSITORY: metadata.repository,
  GITHUB_SHA: metadata.controllerSha,
  GITHUB_RUN_ID: String(metadata.runId),
  GITHUB_RUN_ATTEMPT: '1',
};

test('fork PR identity remains separate from the trusted controller revision', () => {
  assert.deepEqual(captureContext(event, environment), metadata);
  assert.notEqual(metadata.controllerSha, metadata.headSha);
});

test('rejects forged destination, event, revision or shell-like repository before collection', () => {
  assert.throws(() => captureContext(event, { ...environment, GITHUB_REPOSITORY: 'other/repo' }));
  assert.throws(() => captureContext(event, { ...environment, GITHUB_EVENT_NAME: 'pull_request' }));
  assert.throws(() => captureContext(event, { ...environment, GITHUB_SHA: 'main; echo owned' }));
  const malicious = {
    ...event,
    repository: { full_name: 'owner/repo;echo-owned' },
    pull_request: {
      ...event.pull_request,
      base: { ...event.pull_request.base, repo: { full_name: 'owner/repo;echo-owned' } },
    },
  };
  assert.throws(() =>
    captureContext(malicious, { ...environment, GITHUB_REPOSITORY: 'owner/repo;echo-owned' }),
  );
});

function fixture(output, overrides = {}) {
  const commands = [];
  const calls = [];
  const options = {
    cwd: '/trusted-controller',
    metadata,
    upstream: '/pinned-engine',
    python: '/venv/bin/python',
    output,
    git: async (args) => {
      commands.push(args);
      if (args[0] === 'fetch') return '';
      if (args[0] === 'merge-base') return `${mergeBase}\n`;
      if (args[1] === 'refs/pr-review/head') return `${metadata.headSha}\n`;
      return `${metadata.controllerSha}\n`;
    },
    compare: async (args) => {
      calls.push(['compare', args]);
      return qualityReport();
    },
    renderImpact: async (args) => {
      calls.push(['render', args]);
      return { headSha: metadata.headSha, mergeBaseSha: mergeBase };
    },
    ...overrides,
  };
  return { options, commands, calls };
}

test('fetches immutable PR objects without checkout or PR dependency execution', async () => {
  const output = await mkdtemp(join(tmpdir(), 'review-collect-'));
  try {
    const { options, commands, calls } = fixture(output);
    const result = await collectReviewSignals(options);
    assert.equal(result.context.controllerSha, metadata.controllerSha);
    assert.equal(result.context.mergeBaseSha, mergeBase);
    assert.equal(commands.filter((args) => args[0] === 'fetch').length, 1);
    assert.ok(commands.every((args) => ['fetch', 'rev-parse', 'merge-base'].includes(args[0])));
    assert.deepEqual(
      commands.find((args) => args[0] === 'fetch'),
      [
        'fetch',
        '--no-tags',
        '--no-recurse-submodules',
        `https://github.com/${metadata.repository}.git`,
        metadata.baseSha,
        '+refs/pull/582/head:refs/pr-review/head',
      ],
    );
    assert.equal(calls[0][1].cwd, '/trusted-controller');
    assert.equal(calls[0][1].pr, metadata.headSha);
    assert.equal(calls[1][1].repo, '/trusted-controller');
    assert.equal(calls[1][1].headSha, metadata.headSha);
    assert.deepEqual(
      JSON.parse(await readFile(join(output, 'context.json'), 'utf8')),
      result.context,
    );
    assert.equal(
      JSON.parse(await readFile(join(output, 'quality/comparison.json'), 'utf8')).pr,
      metadata.headSha,
    );
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('invalid metadata and changed controller reject before fetch or analysis', async () => {
  const { options, commands, calls } = fixture('/unused', {
    metadata: { ...metadata, prNumber: '582; echo owned' },
  });
  await assert.rejects(collectReviewSignals(options), /Invalid trusted PR event/);
  assert.equal(commands.length, 0);
  const changed = fixture('/unused', { git: async () => `${'e'.repeat(40)}\n` });
  await assert.rejects(collectReviewSignals(changed.options), /Controller checkout changed/);
  assert.equal(changed.calls.length, 0);
  assert.equal(calls.length, 0);
});

test('a PR advancing during fetch produces no report and no analysis', async () => {
  const { options, calls } = fixture('/unused');
  const real = options.git;
  options.git = async (args) =>
    args[1] === 'refs/pr-review/head' ? `${'e'.repeat(40)}\n` : real(args);
  await assert.rejects(collectReviewSignals(options), /PR advanced/);
  assert.equal(calls.length, 0);
});

test('first map retains available measured coverage from the same legacy comparison', async () => {
  const output = await mkdtemp(join(tmpdir(), 'review-collect-'));
  try {
    const previous = qualityReport(true);
    const legacyQualityPath = join(output, 'previous.json');
    await writeFile(legacyQualityPath, JSON.stringify(previous));
    const qualityRun = { id: 42, attempt: 3 };
    const { options } = fixture(output, { legacyQualityPath, legacyQualityRun: qualityRun });
    const result = await collectReviewSignals(options);
    assert.equal(result.quality.files[0].after[0].coverage.percent, 100);
    assert.deepEqual(result.context.qualityRun, qualityRun);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});

test('stale legacy coverage cannot enrich a different head and does not block the static map', async () => {
  const output = await mkdtemp(join(tmpdir(), 'review-collect-'));
  try {
    const previous = { ...qualityReport(true), pr: 'e'.repeat(40) };
    const legacyQualityPath = join(output, 'previous.json');
    await writeFile(legacyQualityPath, JSON.stringify(previous));
    const warnings = [];
    const { options, calls } = fixture(output, {
      legacyQualityPath,
      legacyQualityRun: { id: 42, attempt: 1 },
      warn: (warning) => warnings.push(warning),
    });
    const result = await collectReviewSignals(options);
    assert.equal(result.quality.files[0].after[0].coverage.status, 'unknown');
    assert.equal(result.context.qualityRun, undefined);
    assert.equal(calls[1][0], 'render');
    assert.match(warnings[0], /another comparison/);
  } finally {
    await rm(output, { recursive: true, force: true });
  }
});
