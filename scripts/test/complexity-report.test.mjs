import assert from 'node:assert/strict';
import test from 'node:test';
import {
  changeIcon,
  renderComparison,
  renderComplexityDetails,
  renderDependencyDetails,
} from '../complexity-report.mjs';

const row = (before, after, coverageDelta) => ({
  path: 'lambda/demo/index.js',
  line: 1,
  function: 'run',
  before,
  after,
  delta: before === null ? null : after - before,
  coverage: { change: { percentagePoints: coverageDelta } },
});

test('detail artifacts include every function and importer, with escaped Markdown', () => {
  const functions = Array.from({ length: 25 }, (_, index) => ({
    name: `fn${index}|<tag>`,
    line: index + 1,
    score: 1,
    coverage: { status: 'measured', percent: 50, uncovered: 1 },
  }));
  const report = {
    files: [{ path: 'lambda/a|b.js', before: functions, after: functions }],
    dependencies: [
      {
        path: 'lambda/a|b.js',
        importers: Array.from({ length: 25 }, (_, index) => `lambda/${index}|<tag>.js`),
      },
    ],
  };
  const complexity = renderComplexityDetails(report);
  assert.equal(complexity.split('\n').filter((line) => /^\| (Base|PR) \|/.test(line)).length, 50);
  assert.match(complexity, /fn24&#124;&#60;tag&#62;/);
  assert.doesNotMatch(complexity, /<tag>|Showing 20/);
  const dependencies = renderDependencyDetails(report);
  assert.equal(dependencies.split('\n').filter((line) => line.startsWith('- ')).length, 25);
  assert.match(dependencies, /lambda\/24&#124;&#60;tag&#62;.js/);
  assert.match(renderDependencyDetails({ dependencies: [] }), /No source files changed/);
});

test('green requires improvement without a worsening metric', () => {
  assert.equal(changeIcon(row(50, 40, 10)), '🟢');
  assert.equal(changeIcon(row(50, 40, 0)), '🟢');
  assert.equal(changeIcon(row(50, 50, 5)), '🟢');
  assert.equal(changeIcon(row(50, 40, -1)), '🟠');
  assert.equal(changeIcon(row(50, 51, 30)), '🟠');
  assert.equal(changeIcon(row(50, 50, 0)), '🟠');
});

test('purple requires both metrics to cross their substantial-regression thresholds', () => {
  assert.equal(changeIcon(row(50, 60, -10)), '🟣');
  assert.equal(changeIcon(row(50, 59, -10)), '🔴');
  assert.equal(changeIcon(row(50, 60, -9)), '🔴');
  assert.equal(changeIcon(row(100, 120, -20)), '🟣');
});

test('mixed changes are balanced using relative complexity and coverage percentage points', () => {
  assert.equal(changeIcon(row(50, 55, -5)), '🔴');
  assert.equal(changeIcon(row(50, 54, -5)), '🟠');
  assert.equal(changeIcon(row(50, 60, 5)), '🟠');
  assert.equal(changeIcon(row(50, 70, 5)), '🔴');
  assert.equal(changeIcon(row(100, 110, -5)), '🔴');
  assert.equal(changeIcon(row(50, 40, -20)), '🔴');
});

test('a five-point floor avoids exaggerating tiny complexity increases', () => {
  assert.equal(changeIcon(row(1, 2, -10)), '🔴');
  assert.equal(changeIcon(row(1, 6, -10)), '🟣');
  assert.equal(changeIcon(row(0, 5, -10)), '🟣');
});

test('frontend complexity uses a ten-point floor and still accounts for coverage', () => {
  const frontend = (before, after, delta) => ({
    ...row(before, after, delta),
    path: 'frontend/src/view.tsx',
  });
  assert.equal(changeIcon(frontend(11, 16, null)), '🟠');
  assert.equal(changeIcon(frontend(11, 21, null)), '🔴');
  assert.equal(changeIcon(frontend(11, 16, 0)), '🟠');
  assert.equal(changeIcon(frontend(11, 16, -10)), '🔴');
  assert.equal(changeIcon(frontend(11, 21, -10)), '🟣');
});

test('missing comparisons use current complexity, with strict threshold boundaries', () => {
  for (const [score, icon] of [
    [15, '🟢'],
    [16, '🟠'],
    [50, '🟠'],
    [51, '🔴'],
    [100, '🔴'],
    [101, '🟣'],
  ]) {
    assert.equal(changeIcon(row(null, score, null)), icon, `complexity ${score}`);
  }
  assert.equal(changeIcon(row(50, 70, null)), '🔴');
  assert.equal(changeIcon({ ...row(50, 70, -20), coverage: undefined }), '🔴');
});

test('missing coverage preserves the complexity delta instead of escalating existing debt', () => {
  assert.equal(changeIcon(row(167, 168, null)), '🟠');
  assert.equal(changeIcon({ ...row(167, 168, null), coverage: undefined }), '🟠');
  assert.equal(changeIcon(row(168, 167, null)), '🟢');
  assert.equal(changeIcon(row(167, 210, null)), '🔴');
  assert.equal(changeIcon(row(null, 168, null)), '🟣');
});

test('low measured PR coverage escalates current risk, but unknown and branchless coverage do not', () => {
  const current = (score, percent, status = 'measured') => ({
    ...row(null, score, null),
    coverage: { after: { status, percent } },
  });
  assert.equal(changeIcon(current(20, 49.9)), '🔴');
  assert.equal(changeIcon(current(70, 0)), '🟣');
  assert.equal(changeIcon(current(101, 0)), '🟣');
  assert.equal(changeIcon(current(20, 50)), '🟠');
  assert.equal(changeIcon(current(70, 100)), '🔴');
  assert.equal(changeIcon(current(20, null)), '🟠');
  assert.equal(changeIcon(current(70, null, 'unknown')), '🔴');
});

test('Markdown keeps the table and a compact two-line legend', () => {
  const report = {
    mergeBase: 'a'.repeat(40),
    pr: 'b'.repeat(40),
    analyzer: { threshold: 15 },
    files: [],
    findings: [{ ...row(50, 60, -10), dependentFiles: 12 }],
    improvements: [row(50, 40, 10)],
  };
  const markdown = renderComparison(report);
  assert.match(markdown, /Automated quality report using code complexity and test coverage/);
  assert.match(
    markdown,
    /Review 🟣 and 🔴 items first: consider simplifying the code, improving test coverage, or both/,
  );
  assert.match(markdown, /\| 🟣 \| lambda\/demo\/index.js/);
  assert.match(markdown, /\| 🟢 \| lambda\/demo\/index.js/);
  assert.doesNotMatch(markdown, /\| Signal \|/);
  assert.doesNotMatch(markdown, /## Complexity improvements/);
  assert.equal(markdown.match(/\| File \/ function \|/g).length, 1);
  assert.doesNotMatch(markdown, /Merge base|a{40}|b{40}/);
  assert.ok(
    markdown.endsWith(
      '🟢 Improving · 🟠 Needs attention · 🔴 High risk · 🟣 Highest risk\n\n' +
        '— = unavailable · n/a = not applicable · \\* = incomplete tests\n',
    ),
  );
  assert.ok(markdown.length < 1500, 'A two-row report should stay brief');
  assert.match(markdown, /\| Depending files \|/);
  assert.match(markdown, /\| 12 \|/);
  assert.match(markdown, /\| unknown \|/);
});

test('tables prioritize purple, red, orange, green before truncation and preserve ties', () => {
  const orange = { ...row(50, 51, 0), function: 'orange' };
  const red = { ...row(50, 60, 0), function: 'red' };
  const purple = { ...row(50, 60, -10), function: 'purple' };
  const green = { ...row(50, 40, 0), function: 'green' };
  const rows = [orange, red, purple, { ...red, function: 'red-tie' }];
  const report = { files: [], analyzer: { threshold: 15 }, findings: rows, improvements: [green] };
  const markdown = renderComparison(report);
  const rendered = markdown.split('\n').filter((line) => /^\| [🟣🔴🟠🟢]/u.test(line));
  assert.deepEqual(
    rendered.map((line) => line.split(' | ')[0]),
    ['| 🟣', '| 🔴', '| 🔴', '| 🟠', '| 🟢'],
  );
  assert.match(rendered[1], /— red \|/);
  assert.match(rendered[2], /— red-tie \|/);
  assert.equal(rows[0], orange, 'Rendering must not reorder the report data');
  const capped = renderComparison({
    ...report,
    findings: [...Array.from({ length: 20 }, () => ({ ...orange })), purple],
    improvements: [],
  });
  assert.match(
    capped.split('\n').find((line) => line.startsWith('| 🟣')),
    /— purple \|/,
  );
  assert.match(capped, /Showing 20 of 21/);
});

test('an improvement with a coverage regression is shown once with its warning color', () => {
  const change = { ...row(50, 49, -10), function: 'mixed' };
  const markdown = renderComparison({
    files: [],
    analyzer: { threshold: 15 },
    findings: [{ ...change, kind: 'coverage-decreased' }],
    improvements: [{ ...change, kind: 'improved' }],
  });
  assert.equal(markdown.match(/— mixed \|/g).length, 1);
  assert.doesNotMatch(markdown, /Highlighted functions/);
  assert.match(markdown, /\| 🟠 \|/);
});

test('missing coverage is explained once without repeated diagnostics or unknown arrows', () => {
  const missing = {
    ...row(26, 24, null),
    dependentFiles: 1,
    coverage: { before: { status: 'unknown' }, after: { status: 'unknown' }, change: null },
  };
  const report = {
    files: [],
    analyzer: { threshold: 15 },
    findings: [],
    improvements: [missing],
    coverageNotes: [
      'Merge-base coverage: unknown (no report supplied).',
      'PR coverage: unknown (no report supplied).',
    ],
  };
  const markdown = renderComparison(report);
  assert.doesNotMatch(markdown, /Highlighted functions|no report supplied|unknown|\? → \?/);
  assert.equal(markdown.match(/Some coverage data is unavailable or incomplete/g).length, 1);
  assert.match(markdown, /\| 🟢 \|[^\n]*\| — \| — \| — \| 1 \|/);
  const measured = { status: 'measured', percent: 75, uncovered: 1 };
  const oneSide = renderComparison({
    ...report,
    improvements: [
      {
        ...missing,
        coverage: { ...missing.coverage, after: measured },
      },
    ],
  });
  assert.match(oneSide, /— → 75.0%/);
  assert.match(oneSide, /— → 1/);
  const complete = renderComparison({
    ...report,
    coverageNotes: [],
    improvements: [
      {
        ...missing,
        coverage: { before: measured, after: measured, change: { percentagePoints: 0 } },
      },
    ],
  });
  assert.doesNotMatch(complete, /coverage data is unavailable|no report supplied/);
});

test('a measured finding does not hide failed coverage in another changed scope', () => {
  const measured = { status: 'measured', percent: 75, uncovered: 1 };
  const report = {
    files: [{ path: 'lambda/demo/index.js' }, { path: 'frontend/src/view.tsx' }],
    analyzer: { threshold: 15 },
    findings: [
      {
        ...row(26, 27, 0),
        coverage: { before: measured, after: measured, change: { percentagePoints: 0 } },
      },
    ],
    improvements: [],
    coverageNotes: ['Frontend PR coverage: unknown (no report supplied).'],
  };
  assert.match(renderComparison(report), /Some coverage data is unavailable or incomplete/);
  const frontendOnly = renderComparison({
    ...report,
    files: [{ path: 'frontend/src/view.tsx' }],
    findings: [{ ...report.findings[0], path: 'frontend/src/view.tsx' }],
    coverageNotes: ['PR coverage: unknown (no report supplied).'],
  });
  assert.doesNotMatch(frontendOnly, /coverage data is unavailable/);
});

test('frontend depending files are n/a, while unavailable backend counts remain unknown', () => {
  const markdown = renderComparison({
    files: [],
    analyzer: { threshold: 15 },
    findings: [
      { ...row(167, 168, null), path: 'frontend/src/example.tsx', dependentFiles: null },
      { ...row(167, 168, null), path: 'lambda/missing.js', dependentFiles: null },
      { ...row(167, 168, null), path: 'lambda/entry.js', dependentFiles: 0 },
    ],
    improvements: [],
  });
  assert.match(markdown, /\| 🟠 \| frontend\/src\/example.tsx[^\n]*\| n\/a \|/);
  assert.match(markdown, /lambda\/missing.js[^\n]*\| unknown \|/);
  assert.match(markdown, /lambda\/entry.js[^\n]*\| 0 \|/);
});

test('high usage amplifies coverage risk one level, but preserves green improvements', () => {
  const risk = (count, delta, percent = 80) => ({
    ...row(50, 52, delta),
    dependentFiles: count,
    coverage: { after: { status: 'measured', percent }, change: { percentagePoints: delta } },
  });
  assert.equal(changeIcon(risk(10, -1)), '🟠');
  assert.equal(changeIcon(risk(11, -1)), '🔴');
  assert.equal(changeIcon(risk(11, -10)), '🟣');
  assert.equal(changeIcon(risk(11, 0, 49.9)), '🔴');
  assert.equal(changeIcon(risk(11, 0, 50)), '🟠');
  assert.equal(changeIcon(risk(null, -1)), '🟠');
  assert.equal(changeIcon({ ...row(null, 20, null), dependentFiles: 50 }), '🟠');
  assert.equal(
    changeIcon({
      ...row(50, 40, 5),
      dependentFiles: 50,
      coverage: { after: { status: 'measured', percent: 40 }, change: { percentagePoints: 5 } },
    }),
    '🟢',
  );
  assert.equal(changeIcon({ ...row(50, 60, -10), dependentFiles: 50 }), '🟣');
  assert.equal(
    changeIcon({
      ...row(50, 52, 0),
      dependentFiles: 11,
      coverage: { change: { percentagePoints: 0, uncovered: 1 } },
    }),
    '🔴',
  );
});
