import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';
import {
  commentMarker,
  publishComplexityComment,
  qualityArtifactNames,
  validateReport,
} from '../publish-complexity-comment.mjs';

const base = 'a'.repeat(40);
const prSha = 'b'.repeat(40);
const report = () => ({
  schemaVersion: 1,
  baseRef: 'main',
  base,
  mergeBase: base,
  pr: prSha,
  analyzer: { threshold: 15 },
  files: [],
  coverageNotes: [],
  improvements: [],
  findings: [
    {
      path: 'lambda/<img>@maintainers|evil.js',
      function: '[click](https://example.com)',
      line: 1,
      before: 16,
      after: 20,
      delta: 4,
      dependentFiles: 12,
      kind: 'increased',
      coverage: {
        before: { status: 'measured', total: 4, covered: 4, uncovered: 0, percent: 100 },
        after: { status: 'measured', total: 4, covered: 2, uncovered: 2, percent: 50 },
        change: { percentagePoints: 'untrusted', uncovered: 1000 },
      },
    },
  ],
});

async function fixture(t, contents = report()) {
  const cwd = await mkdtemp(join(tmpdir(), 'quality-comment-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const reportPath = join(cwd, 'comparison.json');
  await writeFile(reportPath, JSON.stringify(contents));
  const pr = {
    number: 42,
    state: 'open',
    head: { sha: prSha, repo: { id: 2 } },
    base: { sha: base, ref: 'main' },
  };
  const comments = [];
  const writes = [];
  const context = {
    eventName: 'workflow_run',
    repo: { owner: 'example', repo: 'project' },
    payload: {
      repository: { id: 1 },
      workflow_run: {
        event: 'pull_request',
        name: 'PR Quality',
        id: 123,
        run_attempt: 1,
        repository: { id: 1 },
        head_repository: { id: 2 },
        head_sha: prSha,
      },
    },
  };
  const listPulls = () => {};
  const listComments = () => {};
  const github = {
    paginate: async (method) => (method === listPulls ? [pr] : comments),
    rest: {
      repos: {
        compareCommitsWithBasehead: async (input) => {
          assert.equal(input.basehead, `main...${prSha}`);
          return { data: { merge_base_commit: { sha: base } } };
        },
      },
      pulls: { list: listPulls, get: async () => ({ data: pr }) },
      issues: {
        listComments,
        createComment: async (input) => writes.push({ action: 'create', ...input }),
        updateComment: async (input) => writes.push({ action: 'update', ...input }),
      },
    },
  };
  return { github, context, reportPath, warn: () => {}, pr, comments, writes };
}

test('posts to the GitHub-verified fork PR and escapes artifact content', async (t) => {
  const data = report();
  data.pullNumber = 999; // Artifacts do not choose the destination.
  data.dependencyNote = 'Depending files: unknown (dependency analysis failed).';
  data.findings[0].dependentFiles = null;
  const f = await fixture(t, data);
  await publishComplexityComment(f);
  assert.equal(f.writes.length, 1);
  assert.equal(f.writes[0].issue_number, 42);
  assert.equal(f.writes[0].action, 'create');
  assert.match(f.writes[0].body, /100.0% → 50.0%/);
  assert.match(f.writes[0].body, /Depending files: unknown \(dependency analysis failed\)/);
  assert.doesNotMatch(f.writes[0].body, /@maintainers|<img>|\[click\]/);
  assert.match(f.writes[0].body, /&#64;maintainers/);
});

test('updates only the bot-owned marked comment and ignores stale reruns', async (t) => {
  const f = await fixture(t);
  f.comments.push(
    { id: 1, user: { login: 'human', type: 'User' }, body: commentMarker },
    {
      id: 2,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `${commentMarker}\n<!-- quality-run:122:1 -->`,
    },
  );
  await publishComplexityComment(f);
  assert.equal(f.writes[0].action, 'update');
  assert.equal(f.writes[0].comment_id, 2);
  f.writes.length = 0;
  f.comments[1].body = `${commentMarker}\n<!-- quality-run:123:2 -->`;
  await publishComplexityComment(f);
  assert.deepEqual(f.writes, []);
});

test('does not post stale PR commit, wrong repository, or a non-PR workflow', async (t) => {
  for (const change of [
    (f) => {
      f.pr.head.sha = 'c'.repeat(40);
    },
    (f) => {
      f.pr.head.repo.id = 3;
    },
    (f) => {
      f.context.payload.workflow_run.repository.id = 3;
    },
    (f) => {
      f.context.payload.workflow_run.event = 'push';
    },
  ]) {
    const f = await fixture(t);
    change(f);
    await publishComplexityComment(f);
    assert.deepEqual(f.writes, []);
  }
  const f = await fixture(t);
  f.github.rest.pulls.get = async () => ({ data: { ...f.pr, state: 'closed' } });
  await publishComplexityComment(f);
  assert.deepEqual(f.writes, []);
});

test('replaces stale results with an explicit unavailable message on malformed or missing artifacts', async (t) => {
  for (const contents of [{ findings: [] }, report()]) {
    const f = await fixture(t, contents);
    if (contents.schemaVersion) await rm(f.reportPath);
    await publishComplexityComment(f);
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].body, /Quality report unavailable — see CI logs\./);
    assert.doesNotMatch(f.writes[0].body, /clean result/);
    assert.doesNotMatch(f.writes[0].body, /0 new\/unmatched/);
  }
});

test('validates numbers and derives coverage deltas rather than trusting the artifact', () => {
  const valid = validateReport(report());
  assert.equal(valid.findings[0].coverage.change.percentagePoints, -50);
  for (const change of [
    (r) => {
      r.findings[0].after = 'injection';
    },
    (r) => {
      r.pr = '<!-- injected -->';
    },
    (r) => {
      r.findings[0].coverage.after.percent = 100;
    },
    (r) => {
      r.findings[0].coverage.after = {};
    },
    (r) => {
      r.findings[0].delta = 999;
    },
    (r) => {
      r.findings[0].dependentFiles = '<img>@maintainers';
    },
    (r) => {
      r.findings[0].dependentFiles = -1;
    },
    (r) => {
      r.dependencyNote = {};
    },
  ]) {
    const data = report();
    change(data);
    assert.throws(() => validateReport(data), /Invalid report/);
  }
});

test('bounds the rendered comment even when escaping expands long artifact strings', async (t) => {
  const data = report();
  data.findings = Array.from({ length: 20 }, () => ({
    ...data.findings[0],
    path: '~'.repeat(500),
  }));
  data.improvements = data.findings;
  const f = await fixture(t, data);
  await publishComplexityComment(f);
  assert.equal(f.writes.length, 1);
  assert.ok(f.writes[0].body.length < 60000);
  assert.match(f.writes[0].body, /Display truncated/);
});

async function sameRepositoryFixture(t) {
  const f = await fixture(t);
  f.pr.head.repo.id = 1;
  f.context.eventName = 'pull_request';
  f.context.actor = 'maintainer';
  f.context.runId = 123;
  f.attempt = 1;
  delete f.context.payload.workflow_run;
  f.context.payload.pull_request = structuredClone(f.pr);
  return f;
}

for (const [name, createFixture] of [
  ['same repository', sameRepositoryFixture],
  ['fork', fixture],
]) {
  test(`${name}: posts validated JSON through the shared publisher`, async (t) => {
    const f = await createFixture(t);
    await publishComplexityComment(f);
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].body, /100.0% → 50.0%/);
    assert.doesNotMatch(f.writes[0].body, /@maintainers|<img>|\[click\]/);
    assert.match(f.writes[0].body, /<!-- quality-run:123:1 -->/);
  });

  test(`${name}: target tip advances but merge base is unchanged`, async (t) => {
    const f = await createFixture(t);
    f.pr.base.sha = 'c'.repeat(40);
    await publishComplexityComment(f);
    assert.equal(f.writes.length, 1);
    assert.match(f.writes[0].body, /100.0% → 50.0%/);
  });

  test(`${name}: retarget or changed merge base produces an explicit stale notice`, async (t) => {
    for (const retarget of [true, false]) {
      const f = await createFixture(t);
      if (retarget) f.pr.base.ref = 'release';
      else
        f.github.rest.repos.compareCommitsWithBasehead = async () => ({
          data: { merge_base_commit: { sha: 'c'.repeat(40) } },
        });
      await publishComplexityComment(f);
      assert.equal(f.writes.length, 1);
      assert.match(f.writes[0].body, /target branch or merge base changed/);
      assert.doesNotMatch(f.writes[0].body, /100.0% → 50.0%/);
    }
  });

  test(`${name}: comment-only rerun retains the earlier producer's report`, async (t) => {
    const f = await createFixture(t);
    f.attempt = 2;
    if (f.context.payload.workflow_run) f.context.payload.workflow_run.run_attempt = 2;
    f.comments.push({
      id: 2,
      user: { login: 'github-actions[bot]', type: 'Bot' },
      body: `${commentMarker}\n<!-- quality-run:123:1 -->\nGood report`,
    });
    // The selector below resolves report attempt 1 for download; publishing it
    // uses attempt 2 for ordering without changing the validated measurements.
    await publishComplexityComment(f);
    assert.equal(f.writes[0].action, 'update');
    assert.match(f.writes[0].body, /100.0% → 50.0%/);
    assert.match(f.writes[0].body, /<!-- quality-run:123:2 -->/);
  });
}

test('same-repository path rejects forks, Dependabot, and stale PR state', async (t) => {
  for (const change of [
    (f) => {
      f.context.payload.pull_request.head.repo.id = 2;
    },
    (f) => {
      f.context.actor = 'dependabot[bot]';
    },
    (f) => {
      f.context.eventName = 'push';
    },
    (f) => {
      f.pr.head.sha = 'c'.repeat(40);
    },
    (f) => {
      f.pr.head.repo.id = 2;
    },
    (f) => {
      f.pr.state = 'closed';
    },
  ]) {
    const f = await sameRepositoryFixture(t);
    change(f);
    await publishComplexityComment(f);
    assert.deepEqual(f.writes, []);
  }
});

async function selectArtifacts(jobs, attempt = 2) {
  return qualityArtifactNames({
    repo: { owner: 'example', repo: 'project' },
    runId: 123,
    attempt,
    github: {
      rest: { actions: { listJobsForWorkflowRun: 'jobs' } },
      paginate: async (method, params) => {
        assert.equal(method, 'jobs');
        assert.equal(params.run_id, 123);
        assert.equal(params.filter, 'all');
        return jobs;
      },
    },
  });
}
const job = (name, run_attempt, conclusion = 'success') => ({ name, run_attempt, conclusion });

test('report rerun reuses coverage from producers that were not rerun', async () => {
  assert.deepEqual(
    await selectArtifacts([
      job('coverage-base', 1),
      job('coverage-pr', 1),
      job('report', 1, 'failure'),
      job('report', 2, null),
    ]),
    { base: 'coverage-base-1', pr: 'coverage-pr-1', report: 'pr-quality-2' },
  );
});

test('comment-only rerun resolves the previous report producer', async () => {
  assert.equal(
    (
      await selectArtifacts([
        job('report', 1),
        job('comment', 1, 'failure'),
        job('comment', 2, null),
      ])
    ).report,
    'pr-quality-1',
  );
});

test('failed producer rerun never falls back to an older artifact', async () => {
  assert.deepEqual(
    await selectArtifacts([
      job('coverage-base', 1),
      job('coverage-pr', 1),
      job('report', 1),
      job('coverage-pr', 2, 'failure'),
      job('report', 2, 'failure'),
      job('coverage-base', 3),
      job('report', 3),
    ]),
    { base: 'coverage-base-1', pr: 'coverage-pr-2', report: 'pr-quality-2' },
  );
});

test('skipped producers do not supply old measurements', async () => {
  assert.deepEqual(
    await selectArtifacts([
      job('coverage-base', 1),
      job('coverage-base', 2, 'skipped'),
      job('coverage-pr', 2, 'skipped'),
    ]),
    { base: '', pr: '', report: '' },
  );
});

test('both workflow paths download selected producer artifacts and call the shared publisher', () => {
  for (const file of ['pr-quality.yml', 'pr-quality-comment.yml']) {
    const workflow = yaml.load(
      readFileSync(new URL(`../../.github/workflows/${file}`, import.meta.url), 'utf8'),
    );
    const steps = workflow.jobs.comment.steps;
    const scripts = steps.filter((step) => step.with?.script).map((step) => step.with.script);
    assert.ok(scripts.some((script) => script.includes('qualityArtifactNames')));
    assert.ok(scripts.some((script) => script.includes('await publishComplexityComment')));
    const download = steps.find((step) => step.uses.startsWith('actions/download-artifact@'));
    assert.equal(download.with.name, '${{ steps.artifacts.outputs.report }}');
    const checkout = steps.find((step) => step.uses.startsWith('actions/checkout@'));
    assert.equal(checkout.with['persist-credentials'], false);
    if (file === 'pr-quality-comment.yml') assert.equal(checkout.with.ref, undefined);
    else {
      assert.equal(checkout.with.ref, '${{ github.sha }}');
      const uploads = workflow.jobs.report.steps
        .filter((step) => step.uses?.startsWith('actions/upload-artifact@'))
        .map((step) => [step.with.name, step.with.path]);
      assert.deepEqual(uploads, [
        ['pr-quality-${{ github.run_attempt }}', 'reports/complexity/comparison.json'],
        ['complexity-${{ github.run_attempt }}', 'reports/complexity/complexity.*'],
        ['dependencies-${{ github.run_attempt }}', 'reports/complexity/dependencies.*'],
      ]);
    }
  }
});

test('workflow tools support PR heads that predate them without measuring the merge commit', async (t) => {
  const cwd = await realpath(await mkdtemp(join(tmpdir(), 'quality-old-pr-')));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const source = join(cwd, 'source');
  await mkdir(source);
  const git = (...args) =>
    execFileSync('git', args, {
      cwd: source,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  git('init', '-q');
  git('config', 'user.name', 'Test');
  git('config', 'user.email', 'test@example.com');
  git('config', 'commit.gpgsign', 'false');
  await writeFile(join(source, 'app.js'), 'export const value = 1;\n');
  git('add', '.');
  git('commit', '-qm', 'common ancestor');
  const baseSha = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'old-pr');
  await writeFile(join(source, 'app.js'), 'export const value = 2;\n');
  git('commit', '-qam', 'PR change before quality tooling');
  const headSha = git('rev-parse', 'HEAD');
  git('checkout', '-qb', 'target', baseSha);
  await mkdir(join(source, 'scripts'));
  const scripts = [
    'publish-complexity-comment.mjs',
    'complexity-report.mjs',
    'complexity-coverage.mjs',
  ];
  for (const name of scripts) {
    await writeFile(
      join(source, 'scripts', name),
      readFileSync(new URL(`../${name}`, import.meta.url)),
    );
  }
  git('add', '.');
  git('commit', '-qm', 'add quality tools');
  git('merge', '--no-ff', 'old-pr', '-qm', 'synthetic PR merge');
  const mergeSha = git('rev-parse', 'HEAD');
  assert.equal(git('ls-tree', headSha, 'scripts/'), '');

  const workflow = yaml.load(
    readFileSync(new URL('../../.github/workflows/pr-quality.yml', import.meta.url), 'utf8'),
  );
  for (const jobName of ['coverage', 'comment', 'report']) {
    const checkout = workflow.jobs[jobName].steps.find((step) =>
      step.uses?.startsWith('actions/checkout@'),
    );
    assert.equal(checkout.with.ref, '${{ github.sha }}', jobName);
  }
  const sourceCheckout = workflow.jobs.coverage.steps.find((step) => step.with?.path === 'source');
  assert.equal(
    sourceCheckout.with.ref,
    "${{ matrix.revision == 'base' && needs.revisions.outputs.merge-base || github.event.pull_request.head.sha }}",
  );
  const compare = workflow.jobs.report.steps.find(
    (step) => step.name === 'Compare complexity and coverage',
  );
  assert.equal(compare.env.PR_SHA, '${{ github.event.pull_request.head.sha }}');
  assert.match(compare.run, /--pr "\$PR_SHA"/);

  const tooling = join(cwd, 'tooling', 'scripts');
  await mkdir(tooling, { recursive: true });
  for (const name of scripts) {
    await writeFile(join(tooling, name), git('show', `${mergeSha}:scripts/${name}`));
  }
  execFileSync(process.execPath, [join(tooling, 'publish-complexity-comment.mjs')]);
  for (const revision of [baseSha, headSha]) {
    git('checkout', '-q', '--detach', revision);
    const output = join(cwd, 'coverage.json');
    execFileSync(process.execPath, [
      join(tooling, 'complexity-coverage.mjs'),
      '--cwd',
      source,
      '--output',
      output,
    ]);
    assert.equal(JSON.parse(readFileSync(output)).revision, revision);
  }
});

test('workflow selects backend and frontend coverage independently', async (t) => {
  const cwd = await mkdtemp(join(tmpdir(), 'quality-paths-'));
  t.after(() => rm(cwd, { recursive: true, force: true }));
  const git = (...args) =>
    execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git('init', '-q');
  git(
    '-c',
    'user.name=Test',
    '-c',
    'user.email=test@example.com',
    '-c',
    'commit.gpgsign=false',
    'commit',
    '--allow-empty',
    '-qm',
    'base',
  );
  const baseSha = git('rev-parse', 'HEAD');
  const workflow = yaml.load(
    readFileSync(new URL('../../.github/workflows/pr-quality.yml', import.meta.url), 'utf8'),
  );
  const script = workflow.jobs.revisions.steps.find((step) => step.id === 'refs').run;
  assert.equal(
    workflow.jobs.coverage.if,
    "needs.revisions.outputs.coverage-needed == 'true' || needs.revisions.outputs.frontend-needed == 'true'",
  );
  for (const [path, expected, frontend] of [
    ['docs/guide.md', false, false],
    ['terraform/main.tf', false, false],
    ['frontend/src/index.ts', false, true],
    ['frontend/package-lock.json', false, true],
    ['frontend/vitest.config.ts', false, true],
    ['lambda/intents/index.js', true, false],
    ['test/setup.js', true, false],
    ['package-lock.json', true, true],
    ['vitest.config.js', true, false],
    ['eslint.complexity.config.mjs', true, true],
    ['scripts/complexity-coverage.mjs', true, true],
    ['scripts/test/compare-complexity.test.mjs', true, true],
    ['.github/workflows/pr-quality.yml', true, true],
  ]) {
    git('checkout', '-q', '--detach', baseSha);
    await mkdir(dirname(join(cwd, path)), { recursive: true });
    await writeFile(join(cwd, path), 'fixture\n');
    git('add', '--', path);
    git(
      '-c',
      'user.name=Test',
      '-c',
      'user.email=test@example.com',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      path,
    );
    const output = join(cwd, 'outputs');
    await writeFile(output, '');
    execFileSync('bash', ['-e', '-c', script], {
      cwd,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        BASE_SHA: baseSha,
        PR_SHA: git('rev-parse', 'HEAD'),
        GITHUB_OUTPUT: output,
      },
    });
    assert.match(readFileSync(output, 'utf8'), new RegExp(`coverage-needed=${expected}\n`), path);
    assert.match(readFileSync(output, 'utf8'), new RegExp(`frontend-needed=${frontend}\n`), path);
  }
});
