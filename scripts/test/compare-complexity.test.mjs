import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { analyzeSource, compareFunctions } from '../complexity-analysis.mjs';
import { compareRevisions, renderComparison } from '../compare-complexity.mjs';
import { attachCoverage, sourceHash } from '../complexity-coverage.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const script = join(root, 'scripts/compare-complexity.mjs');
const branchFunction = (name, score) =>
  `function ${name}(value) {
${Array.from({ length: score }, (_, index) => `if (value === ${index}) return ${index};`).join('\n')}
return -1;
}`;

function repository(t) {
  const cwd = mkdtempSync(join(tmpdir(), 'complexity-compare-'));
  t.after(() => rmSync(cwd, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
  git('init', '-q', '--initial-branch=main');
  git('config', 'user.name', 'Complexity test');
  git('config', 'user.email', 'complexity@example.com');
  const put = (path, source) => {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), source);
  };
  const commit = (message) => {
    git('add', '-A');
    git('-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', 'commit', '-qm', message);
    return git('rev-parse', 'HEAD');
  };
  return { cwd, git, put, commit };
}

test('collects positive and zero scores, keeping nested functions and TSX methods separate', async () => {
  const source = `
export function View({value}: {value: boolean}) {
  function nested() { if (value) { if (value) return 1; } return 0; }
  if (value) return <div>{nested()}</div>;
  return null;
}
class Service {
  run(value: boolean) { if (value) return 1; return 0; }
  get idle() { return true; }
  static run(value: boolean) { if (value) { if (value) return 2; } return 0; }
}
const lookup = {
  left: { run: (value: boolean) => { if (value) return 1; return 0; } },
  right: { run: (value: boolean) => { if (value) return 1; return 0; } },
};
`;
  const results = await analyzeSource(root, 'frontend/src/sample.tsx', source);
  assert.deepEqual(
    results.map(({ score }) => score),
    [1, 3, 1, 0, 3, 1, 1],
  );
  assert.equal(new Set(results.map(({ identity }) => identity)).size, results.length);
  assert.equal(results[1].name, 'View / nested');
});

test('ignores unrelated ESLint directives and fails explicitly on syntax errors', async () => {
  const results = await analyzeSource(
    root,
    'lambda/demo/index.js',
    `// eslint-disable-next-line unknown/rule\n${branchFunction('run', 2)}`,
  );
  assert.equal(results[0].score, 2);
  await assert.rejects(
    analyzeSource(root, 'lambda/demo/index.js', 'export function broken( {'),
    /Parsing error/,
  );
});

test('attributes computed-key methods separately from functions inside their keys', async () => {
  for (const invocation of ['', '()']) {
    for (const keyBody of ["return 'f';", "if (x) return 'f'; return 'g';"]) {
      const source = `const object = {
        [function () { ${keyBody} }${invocation}]() { if (b) return 1; return 0; }
      };`;
      const results = await analyzeSource(root, 'lambda/demo/index.js', source);
      // The function used to compute the key is visited before the method.
      assert.deepEqual(
        results.map(({ score }) => score),
        [keyBody.startsWith('if') ? 1 : 0, 1],
      );
    }
  }
});

test('compares against merge base, not target tip, and reports only relevant changes', async (t) => {
  const repo = repository(t);
  const source = (scores) =>
    Object.entries(scores)
      .map(([name, score]) => branchFunction(name, score))
      .join('\n');
  repo.put(
    'lambda/demo/index.js',
    source({ crossed: 12, increased: 20, stable: 40, improved: 25, small: 1, boundary: 14 }),
  );
  repo.put('lambda/demo/original.js', branchFunction('renamedFile', 18));
  repo.put(
    'lambda/demo/deleted.js',
    branchFunction('deleted', 17).replaceAll('value', 'deletedInput'),
  );
  const ancestor = repo.commit('base');
  // The target advances independently; this must not change the PR's "before".
  repo.put('lambda/demo/index.js', source({ crossed: 2 }));
  repo.commit('target advances');
  repo.git('checkout', '-qb', 'feature', ancestor);
  repo.put(
    'lambda/demo/index.js',
    source({ crossed: 16, increased: 23, stable: 40, improved: 19, small: 2, boundary: 15 }),
  );
  repo.put('frontend/src/new.ts', branchFunction('fresh', 27));
  repo.git('mv', 'lambda/demo/original.js', 'lambda/demo/renamed.js');
  repo.git('rm', '-q', 'lambda/demo/deleted.js');
  repo.put('lambda/demo/test/ignored.js', 'not valid JavaScript {{{');
  repo.put('frontend/src/ignored.test.tsx', 'not valid TSX {{{');
  repo.put('frontend/src/types.d.ts', 'not valid declarations {{{');
  repo.put('scripts/ignored.mjs', 'not valid JavaScript {{{');
  repo.put('eslint.config.mjs', 'throw new Error("Never load PR configuration");');
  const pr = repo.commit('feature');
  // Dirty work is not part of the committed PR comparison.
  repo.put('lambda/demo/index.js', 'not valid JavaScript {{{');

  const report = await compareRevisions({ cwd: repo.cwd, base: 'main', baseRef: 'main' });
  assert.equal(report.baseRef, 'main');
  assert.equal(report.mergeBase, ancestor);
  assert.equal(report.pr, pr);
  assert.notEqual(report.base, ancestor);
  assert.deepEqual(
    report.findings.map(({ function: name, before, after, kind }) => ({
      name,
      before,
      after,
      kind,
    })),
    [
      { name: 'fresh', before: null, after: 27, kind: 'new-or-unmatched' },
      { name: 'crossed', before: 12, after: 16, kind: 'crossed-threshold' },
      { name: 'increased', before: 20, after: 23, kind: 'increased' },
    ],
  );
  assert.deepEqual(
    report.improvements.map(({ function: name, before, after }) => ({ name, before, after })),
    [{ name: 'improved', before: 25, after: 19 }],
  );
  assert.equal(report.files.length, 4);
  const renamed = report.files.find(({ path }) => path === 'lambda/demo/renamed.js');
  assert.equal(renamed.previousPath, 'lambda/demo/original.js');
  assert.equal(renamed.summary.after.maximum, 18);
  const cli = spawnSync(process.execPath, [script, '--base', 'main', '--base-ref', 'main'], {
    cwd: repo.cwd,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(cli.stdout.match(/\| File \/ function \|/g).length, 1);
  const saved = JSON.parse(readFileSync(join(repo.cwd, 'reports/complexity/comparison.json')));
  assert.deepEqual(saved, report);
  assert.equal(
    readFileSync(join(repo.cwd, 'reports/complexity/comparison.md'), 'utf8'),
    cli.stdout,
  );
  const details = JSON.parse(readFileSync(join(repo.cwd, 'reports/complexity/complexity.json')));
  assert.deepEqual(details.files, report.files);
  assert.equal(details.mergeBase, ancestor);
  assert.equal(details.pr, pr);
  const detailMarkdown = readFileSync(join(repo.cwd, 'reports/complexity/complexity.md'), 'utf8');
  assert.match(detailMarkdown, /\| Base \| small \| \d+ \| 1 \|/);
  assert.match(detailMarkdown, /\| PR \| small \| \d+ \| 2 \|/);
  assert.match(detailMarkdown, /\| PR \| stable \| \d+ \| 40 \|/);
  assert.match(detailMarkdown, /Previously: lambda\/demo\/original.js/);
  assert.match(detailMarkdown, /\| Base \| deleted \|/);
  assert.doesNotMatch(detailMarkdown, /\| PR \| deleted \|/);
  const dependencies = JSON.parse(
    readFileSync(join(repo.cwd, 'reports/complexity/dependencies.json')),
  );
  assert.deepEqual(dependencies.files, report.dependencies);
  assert.equal(dependencies.pr, pr);
  assert.deepEqual(
    dependencies.files.find((file) => file.path === 'lambda/demo/deleted.js'),
    {
      path: 'lambda/demo/deleted.js',
      importers: null,
      reason: 'File deleted in PR',
    },
  );
  assert.equal(
    dependencies.files.find((file) => file.path === 'frontend/src/new.ts').reason,
    'Backend only',
  );
  assert.match(cli.stdout, /Some coverage data is unavailable or incomplete/);
  const skipped = spawnSync(process.execPath, [script, '--base', 'main', '--coverage-not-needed'], {
    cwd: repo.cwd,
    encoding: 'utf8',
  });
  assert.equal(skipped.status, 0, skipped.stderr);
  assert.doesNotMatch(skipped.stdout, /Merge-base coverage|PR coverage|no report supplied/);
  const skippedData = JSON.parse(
    readFileSync(join(repo.cwd, 'reports/complexity/comparison.json')),
  );
  assert.ok(skippedData.coverageNotes.some((note) => note.includes('not needed for this change')));
});

test('recognizes unchanged moved functions and shifted callbacks without guessing changed callbacks', async () => {
  const named = branchFunction('moveMe', 20);
  const callback = `${branchFunction('callback', 17).replace('function callback', 'function')}`;
  const oldSource = `${named}\nitems.map(${callback});`;
  const newSource = `items.filter(x => x);\nitems.map(${callback});`;
  const before = await analyzeSource(root, 'lambda/demo/from.js', oldSource);
  const after = await analyzeSource(root, 'lambda/demo/from.js', newSource);
  const moved = await analyzeSource(root, 'lambda/demo/to.js', named.replace('moveMe', 'newName'));
  const files = [
    { path: 'lambda/demo/from.js', previousPath: 'lambda/demo/from.js', before, after },
    { path: 'lambda/demo/to.js', previousPath: null, before: [], after: moved },
  ];
  assert.deepEqual(compareFunctions(files).findings, []);

  const changed = await analyzeSource(
    root,
    'lambda/demo/from.js',
    `items.map(${branchFunction('callback', 19).replace('function callback', 'function')});`,
  );
  const report = compareFunctions([{ ...files[0], after: changed }]);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].kind, 'new-or-unmatched');
  assert.equal(report.findings[0].delta, null);
});

test('counts unique direct production importers at the PR commit for every function in a file', async (t) => {
  const repo = repository(t);
  repo.put(
    'lambda/shared/hot.js',
    `export ${branchFunction('hot', 20)}\nexport ${branchFunction('other', 20)}`,
  );
  const base = repo.commit('base');
  repo.put(
    'lambda/shared/hot.js',
    `export ${branchFunction('hot', 25)}\nexport ${branchFunction('other', 25)}`,
  );
  repo.put(
    'lambda/one/index.js',
    "import '../shared/hot.js'; import { hot } from '../shared/hot.js'; throw new Error('must not execute');",
  );
  repo.put('lambda/two/index.js', "export { hot } from '../shared/hot.js';");
  repo.put('lambda/three/index.cjs', "require('../shared/hot.js');");
  repo.put('lambda/four/index.js', "export const load = () => import('../shared/hot.js');");
  repo.put('lambda/unicode/café\nmodule.js', "// café 🚀\nimport '../shared/hot.js';");
  repo.put('lambda/duplicate-a/index.js', "import '../shared/hot.js';");
  repo.put('lambda/duplicate-b/index.js', "import '../shared/hot.js';");
  repo.put('lambda/empty/index.js', '');
  repo.put('.gitattributes', 'lambda/one/index.js export-ignore\n');
  repo.put('lambda/transitive/index.js', "import '../one/index.js';");
  for (const path of [
    'lambda/test/importer.js',
    'lambda/fixtures/importer.js',
    'lambda/one.test.js',
  ]) {
    repo.put(
      path,
      path.endsWith('.test.js') ? "import './shared/hot.js';" : "import '../shared/hot.js';",
    );
  }
  repo.put('.dependency-cruiser.cjs', "throw new Error('must not load PR configuration');");
  repo.commit('pr');
  repo.put('lambda/dirty/index.js', "import '../shared/hot.js';");
  repo.put(
    'lambda/one/index.js',
    '// Removing an import in dirty source must not alter the count.',
  );
  const report = await compareRevisions({ cwd: repo.cwd, base });
  assert.equal(report.findings.length, 2);
  assert.deepEqual(
    report.findings.map((row) => row.dependentFiles),
    [7, 7],
  );
  assert.deepEqual(
    report.dependencies.find((file) => file.path === 'lambda/shared/hot.js').importers,
    [
      'lambda/duplicate-a/index.js',
      'lambda/duplicate-b/index.js',
      'lambda/four/index.js',
      'lambda/one/index.js',
      'lambda/three/index.cjs',
      'lambda/two/index.js',
      'lambda/unicode/café\nmodule.js',
    ],
  );
  assert.deepEqual(
    report.dependencies.find((file) => file.path === 'lambda/one/index.js').importers,
    ['lambda/transitive/index.js'],
  );
});

test('dependency details include changed files even when no function is flagged', async (t) => {
  const repo = repository(t);
  repo.put('lambda/shared/calm.js', `export ${branchFunction('calm', 1)}`);
  repo.put('lambda/demo/index.js', "import '../shared/calm.js';");
  const base = repo.commit('base');
  repo.put('lambda/shared/calm.js', `export ${branchFunction('calm', 2)}`);
  repo.commit('small change');
  const report = await compareRevisions({ cwd: repo.cwd, base });
  assert.deepEqual(report.findings, []);
  assert.deepEqual(report.dependencies, [
    {
      path: 'lambda/shared/calm.js',
      importers: ['lambda/demo/index.js'],
      reason: null,
    },
  ]);
});

test('suppresses unchanged identical callbacks by count and flags only additional copies', async () => {
  const callback = branchFunction('callback', 17).replace('function callback', 'function');
  const before = await analyzeSource(root, 'lambda/demo/index.js', `items.map(${callback});`);
  const after = await analyzeSource(
    root,
    'lambda/demo/index.js',
    `items.map(${callback});\nothers.map(${callback});`,
  );
  const report = compareFunctions([
    { path: 'lambda/demo/index.js', previousPath: 'lambda/demo/index.js', before, after },
  ]);
  assert.equal(report.findings.length, 1);
  assert.ok(report.findings.every(({ before: score, delta }) => score === null && delta === null));
  assert.deepEqual(
    compareFunctions([
      { path: 'lambda/demo/index.js', previousPath: 'lambda/demo/index.js', before: after, after },
    ]).findings,
    [],
  );
  const withCoverage = (partial) =>
    after.map((fn) => ({
      ...fn,
      coverage: { status: 'measured', covered: 1, total: 2, uncovered: 1, percent: 50, partial },
    }));
  assert.deepEqual(
    compareFunctions([
      {
        path: 'lambda/demo/index.js',
        previousPath: 'lambda/demo/index.js',
        before: withCoverage(false),
        after: withCoverage(true),
      },
    ]).findings,
    [],
    'An unrelated test failure must not make unchanged duplicate callbacks look new',
  );
});

test('syntax errors and missing refs fail instead of producing a clean comparison', async (t) => {
  const repo = repository(t);
  repo.put('lambda/demo/index.js', branchFunction('run', 2));
  const base = repo.commit('base');
  repo.put('lambda/demo/index.js', 'function broken( {');
  repo.commit('broken');
  await assert.rejects(compareRevisions({ cwd: repo.cwd, base }), /Parsing error/);
  const cli = spawnSync(process.execPath, [script, '--base', base], {
    cwd: repo.cwd,
    encoding: 'utf8',
  });
  assert.equal(cli.status, 1);
  assert.match(cli.stderr, /Complexity comparison failed/);
  await assert.rejects(compareRevisions({ cwd: repo.cwd, base: 'missing-reference' }));
});

test('rejects source symlinks instead of following them or reporting a zero score', async (t) => {
  const repo = repository(t);
  repo.put('lambda/demo/index.js', branchFunction('run', 2));
  const base = repo.commit('base');
  symlinkSync('index.js', join(repo.cwd, 'lambda/demo/link.js'));
  repo.commit('symlink');
  await assert.rejects(compareRevisions({ cwd: repo.cwd, base }), /expected a regular source file/);
});

test('caps the display without dropping JSON findings and escapes Markdown content', () => {
  const finding = {
    path: 'lambda/a|b<file>.js',
    line: 1,
    function: 'odd`name\ninjected',
    before: null,
    after: 20,
    delta: null,
  };
  const report = {
    mergeBase: 'abc',
    pr: 'def',
    analyzer: { threshold: 15 },
    files: [],
    findings: Array.from({ length: 21 }, () => finding),
    improvements: [],
  };
  const text = renderComparison(report);
  assert.match(text, /Showing 20 of 21/);
  assert.match(text, /a&#124;b&#60;file&#62;/);
  assert.match(text, /odd&#96;name&#10;injected/);
  assert.equal(report.findings.length, 21);
});

test('attributes nested outcomes separately and distinguishes missing coverage from zero', async () => {
  const source = `function outer(x) {
  function inner(y) { if (y) return 1; return 0; }
  if (x) return inner(x);
  return 0;
}`;
  const functions = await analyzeSource(root, 'lambda/demo/index.js', source);
  const file = {
    sourceHash: sourceHash(source),
    branches: [
      { start: { line: 1, column: 0 }, hit: true },
      { start: { line: 2, column: 2 }, hit: false },
      { start: { line: 2, column: 24 }, hit: false },
      { start: { line: 3, column: 2 }, hit: false },
    ],
  };
  const snapshot = { status: 'complete', revision: 'abc' };
  const covered = attachCoverage(functions, source, file, snapshot, 'abc');
  assert.equal(covered[0].coverage.percent, 50);
  assert.equal(covered[1].coverage.percent, 0);
  assert.equal(covered[0].coverage.total, 2);
  for (const [input, revision] of [
    [undefined, 'abc'],
    [snapshot, 'other'],
    [{ status: 'unavailable' }, 'abc'],
  ]) {
    assert.ok(
      attachCoverage(functions, source, file, input, revision).every(
        (fn) => fn.coverage.status === 'unknown',
      ),
    );
  }
  assert.equal(
    attachCoverage(functions, source + '\n', file, snapshot, 'abc')[0].coverage.status,
    'unknown',
  );
  assert.equal(
    attachCoverage(functions, source, undefined, snapshot, 'abc')[0].coverage.status,
    'unknown',
  );
  assert.equal(
    attachCoverage(functions, source, { ...file, branches: [] }, snapshot, 'abc')[0].coverage
      .percent,
    null,
  );
});

test('coverage regressions only report files changed by the PR and reject mismatched instrumentation', async (t) => {
  const repo = repository(t);
  const source = branchFunction('risky', 20);
  repo.put('lambda/demo/index.js', source);
  repo.put('lambda/demo/unchanged.js', source);
  const base = repo.commit('base');
  repo.put('lambda/demo/test/test.js', '// tests changed');
  const testOnlyPr = repo.commit('test only');
  const snapshot = (revision, hit) => ({
    status: 'complete',
    revision,
    instrumenter: { node: '24.21.0', vitest: '4.1.11', provider: '4.1.11', config: 'same' },
    files: {
      'lambda/demo/index.js': {
        sourceHash: sourceHash(source),
        branches: [{ start: { line: 2, column: 0 }, hit }],
      },
      'lambda/demo/unchanged.js': {
        sourceHash: sourceHash(source),
        branches: [{ start: { line: 2, column: 0 }, hit }],
      },
    },
  });
  const baseCoverage = snapshot(base, true);
  const testOnlyReport = await compareRevisions({
    cwd: repo.cwd,
    base,
    baseCoverage,
    prCoverage: snapshot(testOnlyPr, false),
  });
  assert.deepEqual(testOnlyReport.files, []);
  assert.deepEqual(testOnlyReport.findings, []);
  assert.deepEqual(testOnlyReport.improvements, []);
  // A file edit without a complexity change must still expose coverage regressions.
  const changedSource = source.replace('return -1;', 'return -2;');
  repo.put('lambda/demo/index.js', changedSource);
  const pr = repo.commit('source changed');
  const prCoverage = snapshot(pr, false);
  prCoverage.instrumenter.node = '24.22.1';
  prCoverage.files['lambda/demo/index.js'].sourceHash = sourceHash(changedSource);
  const report = await compareRevisions({ cwd: repo.cwd, base, baseCoverage, prCoverage });
  assert.deepEqual(
    report.files.map((file) => file.path),
    ['lambda/demo/index.js'],
  );
  assert.deepEqual(report.improvements, []);
  assert.equal(report.findings.length, 1);
  assert.equal(report.findings[0].path, 'lambda/demo/index.js');
  assert.equal(report.findings[0].kind, 'coverage-decreased');
  assert.equal(report.findings[0].delta, 0);
  assert.equal(report.findings[0].coverage.change.percentagePoints, -100);
  assert.match(renderComparison(report), /100.0% → 0.0%/);
  assert.deepEqual(report.coverageNotes, []);
  // Crash the actual dependency-cruiser child, leaving the comparison CLI running.
  repo.put('base-coverage.json', JSON.stringify(baseCoverage));
  repo.put('pr-coverage.json', JSON.stringify(prCoverage));
  repo.put(
    'crash-depcruise.cjs',
    `
    if (process.argv[1]?.endsWith('dependency-cruise.mjs')) {
      throw new Error('simulated dependency-cruiser crash');
    }
  `,
  );
  const crashed = spawnSync(
    process.execPath,
    [
      script,
      '--base',
      base,
      '--pr',
      pr,
      '--base-coverage',
      'base-coverage.json',
      '--pr-coverage',
      'pr-coverage.json',
    ],
    {
      cwd: repo.cwd,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS ?? ''} --require ${JSON.stringify(join(repo.cwd, 'crash-depcruise.cjs'))}`,
      },
    },
  );
  assert.equal(crashed.status, 0, crashed.stderr);
  const degraded = JSON.parse(
    readFileSync(join(repo.cwd, 'reports/complexity/comparison.json'), 'utf8'),
  );
  assert.deepEqual(
    degraded.findings,
    report.findings.map((row) => ({ ...row, dependentFiles: null })),
  );
  assert.deepEqual(degraded.coverageNotes, report.coverageNotes);
  assert.match(crashed.stdout, /Depending files: unknown \(dependency analysis failed\)/);
  assert.match(crashed.stdout, /100.0% → 0.0%/);
  assert.doesNotMatch(crashed.stdout, /Report unavailable|simulated dependency-cruiser crash/);
  assert.match(crashed.stderr, /Dependency analysis failed:.*simulated dependency-cruiser crash/s);
  const dependencyDetails = JSON.parse(
    readFileSync(join(repo.cwd, 'reports/complexity/dependencies.json'), 'utf8'),
  );
  assert.deepEqual(dependencyDetails.files, [
    {
      path: 'lambda/demo/index.js',
      importers: null,
      reason: 'Dependency analysis unavailable',
    },
  ]);
  assert.match(
    readFileSync(join(repo.cwd, 'reports/complexity/complexity.md'), 'utf8'),
    /\| PR \| risky \| \d+ \| 20 \| 0.0% \| 1 \|/,
  );
  prCoverage.status = 'partial';
  const partial = await compareRevisions({ cwd: repo.cwd, base, baseCoverage, prCoverage });
  assert.equal(partial.findings[0].coverage.change.percentagePoints, -100);
  assert.equal(partial.findings[0].coverage.after.partial, true);
  assert.match(renderComparison(partial), /100.0% → 0.0%\*/);
  assert.match(renderComparison(partial), /Some coverage data is unavailable or incomplete/);
  prCoverage.status = 'complete';
  for (const [key, value] of [
    ['node', '22.22.0'],
    ['vitest', 'different'],
    ['provider', 'different'],
    ['config', 'different'],
  ]) {
    const incompatible = await compareRevisions({
      cwd: repo.cwd,
      base,
      baseCoverage,
      prCoverage: { ...prCoverage, instrumenter: { ...prCoverage.instrumenter, [key]: value } },
    });
    assert.equal(incompatible.findings.length, 0, key);
    assert.match(incompatible.coverageNotes[0], /differs/);
  }
  const unavailable = await compareRevisions({
    cwd: repo.cwd,
    base,
    baseCoverage,
    prCoverage: { status: 'unavailable', revision: pr, files: {} },
  });
  assert.equal(unavailable.files.length, 1);
  assert.equal(unavailable.findings.length, 0);
  assert.match(unavailable.coverageNotes.join('\n'), /PR coverage: unknown.*failed/);
  assert.match(renderComparison(unavailable), /Some coverage data is unavailable or incomplete/);
});

test('frontend coverage stays independent of backend instrumentation and failures', async (t) => {
  const repo = repository(t);
  const before = branchFunction('view', 20);
  const after = branchFunction('view', 21);
  const path = 'frontend/src/view.tsx';
  repo.put(path, before);
  repo.put('lambda/demo/index.js', before);
  const base = repo.commit('base');
  repo.put(path, after);
  repo.put('lambda/demo/index.js', after);
  const pr = repo.commit('pr');
  const snapshot = (revision, source, hit) => ({
    status: 'complete',
    revision,
    instrumenter: { node: '24.22.1', vitest: '4.1.11', provider: '4.1.11', config: 'frontend' },
    files: {
      [path]: {
        sourceHash: sourceHash(source),
        branches: [{ start: { line: 2, column: 0 }, hit }],
      },
    },
  });
  const baseFrontendCoverage = snapshot(base, before, true);
  const prFrontendCoverage = snapshot(pr, after, false);
  const report = await compareRevisions({
    cwd: repo.cwd,
    base,
    baseFrontendCoverage,
    prFrontendCoverage,
    baseCoverage: { status: 'unavailable', revision: base, files: {} },
    prCoverage: { status: 'unavailable', revision: pr, files: {} },
  });
  const frontend = report.findings.find((row) => row.path === path);
  assert.equal(frontend.coverage.change.percentagePoints, -100);
  assert.equal(
    report.findings.find((row) => row.path.startsWith('lambda/')).coverage.after.status,
    'unknown',
  );
  const wrongRevision = await compareRevisions({
    cwd: repo.cwd,
    base,
    baseFrontendCoverage,
    prFrontendCoverage: { ...prFrontendCoverage, revision: base },
  });
  assert.equal(
    wrongRevision.findings.find((row) => row.path === path).coverage.after.status,
    'unknown',
  );
  const incompatible = await compareRevisions({
    cwd: repo.cwd,
    base,
    baseFrontendCoverage,
    prFrontendCoverage: {
      ...prFrontendCoverage,
      instrumenter: { ...prFrontendCoverage.instrumenter, config: 'changed' },
    },
  });
  assert.equal(incompatible.findings.find((row) => row.path === path).coverage.change, null);
});
