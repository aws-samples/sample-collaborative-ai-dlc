import assert from 'node:assert/strict';
import test from 'node:test';
import { comparisonRows, renderComparison } from '../complexity-report.mjs';
import { renderReviewComment } from '../pr-impact/comment.mjs';

const headSha = 'a'.repeat(40);
const assetSha = 'b'.repeat(40);
const imageUrl = `https://raw.githubusercontent.com/aws-samples/sample-collaborative-ai-dlc/${assetSha}/pr-582/map.png`;
const artifactUrl =
  'https://github.com/aws-samples/sample-collaborative-ai-dlc/actions/runs/123#artifacts';
const updatedAt = '2026-10-27T17:28:00.000Z';
const measured = (percent = 80, partial = false) => ({
  status: 'measured',
  percent,
  partial,
  total: 100,
  covered: percent,
  uncovered: 100 - percent,
});
const unknown = { status: 'unknown' };
const row = (index, overrides = {}) => ({
  path: `lambda/demo/file-${index}.js`,
  line: index + 1,
  function: `function${index}`,
  before: 25,
  after: 26,
  delta: 1,
  dependentFiles: 2,
  coverage: { before: unknown, after: unknown, change: null },
  ...overrides,
});
const quality = (overrides = {}) => ({
  pr: headSha,
  analyzer: { threshold: 15 },
  files: [{ path: 'lambda/demo/index.js', before: [], after: [] }],
  findings: [row(0)],
  improvements: [],
  coverageNotes: [],
  ...overrides,
});
const impact = () => ({
  headSha,
  prNumber: 582,
  summary: { files: 3 },
  evidence: {
    annotations: [
      {
        key: 'A',
        path: 'lambda/demo/file-0.js',
        detail: 'body changed · 2 static name-match targets',
      },
      {
        key: 'B',
        path: 'lambda/demo/file-1.js',
        detail: 'file-wide edit · 3 import-fallback targets',
      },
    ],
    summary: { productionReachFiles: 2, testReachFiles: 3, unavailableReachFiles: 1 },
  },
});
const options = (overrides = {}) => ({
  qualityReport: quality(),
  impactReport: impact(),
  imageUrl,
  artifactUrl,
  headSha,
  updatedAt,
  ...overrides,
});
const tableRows = (markdown) => markdown.split('\n').filter((line) => /^\| [🟣🔴🟠🟢]/u.test(line));
const plainRows = (markdown) =>
  tableRows(markdown).map((line) =>
    line.replace(
      /\[([^\]]+)\]\(https:\/\/github\.com\/aws-samples\/sample-collaborative-ai-dlc\/blob\/[a-f0-9]{40}\/[^)]+#L[1-9]\d*\)/g,
      '$1',
    ),
  );

test('combined comment preserves sorted quality rows and independent open disclosures', () => {
  const report = quality({
    findings: Array.from({ length: 15 }, (_, index) => row(index)),
  });
  const markdown = renderReviewComment(options({ qualityReport: report }));
  assert.equal((markdown.match(/<details open>/g) ?? []).length, 2);
  assert.match(markdown, /^\*\*Automatically computed PR review signals \(deterministic\)\*\*/);
  assert.doesNotMatch(
    markdown,
    /TEST PURPOSES|# Complexity and test coverage|Automated quality report/,
  );
  assert.match(markdown, /1 changed JS\/TS file analyzed · 15 flagged functions/);
  assert.match(markdown, /Coverage unavailable; test protection cannot be compared/);
  assert.equal(tableRows(markdown.split('<summary>Show 5 more functions</summary>')[0]).length, 10);
  assert.deepEqual(plainRows(markdown), tableRows(renderComparison(report)));
  assert.ok(
    markdown.includes(
      `[lambda/demo/file-14.js:15](https://github.com/aws-samples/sample-collaborative-ai-dlc/blob/${headSha}/lambda/demo/file-14.js#L15) — function14`,
    ),
  );
  assert.equal((markdown.match(/!\[PR impact map\]/g) ?? []).length, 1);
  assert.match(markdown, /<\/details>\n\n---\n\n<details open>\n<summary>Isobar/);
  assert.match(
    markdown,
    /Red marks changed files; green marks static links, not proven runtime impact or a risk grade/,
  );
  assert.match(markdown, /\[Isobar\].*by \[r3al1tym\]/);
  const signals = markdown.split('<summary>Signals</summary>')[1].split('</details>')[0];
  assert.ok(signals.split('\n').filter((line) => line.startsWith('- ')).length <= 10);
  assert.match(signals, /A: lambda\/demo\/file-0.js/);
  assert.match(signals, /Total static reach: 2 unchanged production files; 3 unchanged test files/);
  assert.match(signals, /Revision: `aaaaaaa`; updated 2026-10-27 17:28 UTC/);
  assert.match(markdown, /Full report artifacts/);
});

test('all purple functions stay visible and every remaining function stays available', () => {
  const findings = [
    ...Array.from({ length: 28 }, (_, index) => row(index)),
    ...Array.from({ length: 12 }, (_, index) =>
      row(index + 28, {
        before: 50,
        after: 60,
        delta: 10,
        coverage: {
          before: measured(80),
          after: measured(70),
          change: { percentagePoints: -10, uncovered: 10 },
        },
      }),
    ),
  ];
  const markdown = renderReviewComment(options({ qualityReport: quality({ findings }) }));
  const initial = tableRows(markdown.split('<summary>Show 28 more functions</summary>')[0]);
  assert.equal(initial.length, 12);
  assert.ok(initial.every((line) => line.startsWith('| 🟣')));
  assert.equal(tableRows(markdown).length, 40);
});

test('partial PR-only coverage retains exact values, improvements and unavailable baseline', () => {
  const report = quality({
    findings: [
      row(0, {
        before: 41,
        after: 43,
        delta: 2,
        coverage: { before: unknown, after: measured(78, true), change: null },
      }),
    ],
    improvements: [
      row(1, {
        before: 26,
        after: 24,
        delta: -2,
        coverage: { before: unknown, after: measured(68, true), change: null },
      }),
    ],
  });
  const markdown = renderReviewComment(options({ qualityReport: report }));
  assert.match(markdown, /1 flagged function · 1 improvement/);
  assert.match(
    markdown,
    /partial PR measurements; no comparable baseline, so no before\/after comparison/,
  );
  assert.match(markdown, /— → 78\.0%\*/);
  assert.match(markdown, /— → 68\.0%\*/);
  assert.deepEqual(plainRows(markdown), tableRows(renderComparison(report)));
  assert.ok(tableRows(markdown)[1].startsWith('| 🟢'));
  assert.doesNotMatch(markdown, /Coverage unavailable;|Some coverage data is unavailable/);
});

test('coverage summaries distinguish complete, mixed, partial and baseline-only measurements', () => {
  const both = row(0, {
    coverage: {
      before: measured(80),
      after: measured(80),
      change: { percentagePoints: 0, uncovered: 0 },
    },
  });
  const render = (findings, extra = {}) =>
    renderReviewComment(options({ qualityReport: quality({ findings, ...extra }) }));
  assert.match(render([both]), /before\/after measurements available for the analyzed functions/);
  assert.match(
    render([both, row(1)]),
    /before\/after measurements available; some data unavailable/,
  );
  assert.doesNotMatch(render([both]), /comparable deltas/);
  assert.match(
    render([row(0, { coverage: { ...both.coverage, after: measured(70, true) } })]),
    /partial measurements\. Available deltas may reflect incomplete tests/,
  );
  assert.match(
    render([row(0, { coverage: { before: measured(80), after: unknown, change: null } })]),
    /baseline measurements only; PR coverage unavailable/,
  );
  assert.match(
    render([both], {
      files: [{ path: 'frontend/src/view.tsx' }],
      coverageNotes: ['Frontend PR coverage: unknown (no report supplied).'],
    }),
    /some data unavailable/,
  );
});

test('complete file coverage without results or warnings hides quality while retaining the map', () => {
  const report = quality({
    findings: [],
    files: [
      {
        path: 'lambda/demo/index.js',
        before: [{ coverage: measured(80) }],
        after: [{ coverage: measured(80) }],
      },
    ],
  });
  const markdown = renderReviewComment(options({ qualityReport: report }));
  assert.match(
    markdown,
    /1 changed JS\/TS file analyzed; no flagged functions, improvements or analysis warnings/,
  );
  assert.doesNotMatch(
    markdown,
    /<summary>Complexity and test coverage|High risk|No production JS\/TS/,
  );
  assert.equal((markdown.match(/<details open>/g) ?? []).length, 1);
  assert.ok(markdown.includes(imageUrl));
  assert.equal(tableRows(markdown).length, 0);
  assert.equal(
    renderReviewComment(
      options({
        qualityReport: report,
        impactReport: undefined,
        imageUrl: undefined,
      }),
    ),
    '',
  );
});

test('file-level coverage and dependency warnings retain quality without an empty color legend', () => {
  for (const [coverage, dependencyNote, expected] of [
    [measured(80, true), undefined, /partial measurements/],
    [unknown, undefined, /Coverage unavailable/],
    [
      measured(80),
      'Depending files: unknown (dependency analysis failed).',
      /dependency analysis failed/,
    ],
  ]) {
    const report = quality({
      findings: [],
      dependencyNote,
      files: [
        {
          path: 'lambda/demo/index.js',
          before: [{ coverage }],
          after: [{ coverage }],
        },
      ],
    });
    const markdown = renderReviewComment(options({ qualityReport: report }));
    assert.match(markdown, /<summary>Complexity and test coverage/);
    assert.match(markdown, expected);
    assert.doesNotMatch(markdown, /High risk|Highest risk/);
    assert.equal(tableRows(markdown).length, 0);
    assert.ok(markdown.includes(imageUrl));
  }
});

test('empty quality scope keeps the map and identifies the unassessed change scope', () => {
  const terraform = { ...impact(), files: [{ path: 'terraform/main.tf' }] };
  const markdown = renderReviewComment(
    options({ qualityReport: quality({ files: [], findings: [] }), impactReport: terraform }),
  );
  assert.equal((markdown.match(/<details open>/g) ?? []).length, 1);
  assert.match(markdown, /No production JS\/TS in scope/);
  assert.match(markdown, /does not assess Terraform or IAM changes/);
  assert.doesNotMatch(markdown, /<summary>Complexity and test coverage|0 flagged|High risk/);
  assert.equal((markdown.match(/!\[PR impact map\]/g) ?? []).length, 1);
  assert.equal(
    renderReviewComment(
      options({
        qualityReport: quality({ files: [], findings: [] }),
        impactReport: undefined,
        imageUrl: undefined,
      }),
    ),
    '',
  );
  for (const path of ['.github/workflows/ci.yml', 'scripts/release.mjs']) {
    const tooling = renderReviewComment(
      options({
        qualityReport: quality({ files: [], findings: [] }),
        impactReport: { ...impact(), files: [{ path }] },
      }),
    );
    assert.match(tooling, /CI and tooling changes are outside these production JS\/TS metrics/);
    assert.doesNotMatch(tooling, /does not assess Terraform/);
  }
  const docs = renderReviewComment(
    options({
      qualityReport: quality({ files: [], findings: [] }),
      impactReport: { ...impact(), files: [{ path: 'docs/index.md' }] },
    }),
  );
  assert.match(docs, /No production JS\/TS in scope\./);
  assert.doesNotMatch(docs, /CI and tooling|does not assess Terraform/);
});

test('missing quality and missing images remain unavailable without broken image Markdown', () => {
  const noQuality = renderReviewComment(options({ qualityReport: undefined }));
  assert.match(noQuality, /Quality report unavailable; this is not a clean result/);
  assert.doesNotMatch(noQuality, /No production JS\/TS/);
  const noImage = renderReviewComment(options({ imageUrl: undefined }));
  assert.match(noImage, /Isobar map unavailable/);
  assert.doesNotMatch(noImage, /!\[|Total static reach|<summary>Isobar/);
  assert.equal(tableRows(noImage).length, 1);
});

test('untrusted labels cannot inject markup, mentions or images and rendering does not mutate data', () => {
  const input = options();
  input.impactReport.evidence.annotations[0].path =
    'lambda/<script>@everyone\n![x](https://bad)/index.js';
  input.impactReport.evidence.annotations[0].detail = '</details><details open>_risk_';
  input.qualityReport.findings[0].function = '<script>@everyone|![x]';
  const original = structuredClone(input);
  const markdown = renderReviewComment(input);
  assert.deepEqual(input, original);
  assert.equal(markdown, renderReviewComment(input));
  assert.doesNotMatch(markdown, /<script>|@everyone|!\[x\]|<\/details><details open>/);
  assert.match(markdown, /&#60;script&#62;&#64;everyone/);
  assert.equal((markdown.match(/!\[PR impact map\]/g) ?? []).length, 1);
});

test('report revisions, publication URLs and timestamps cannot select other content', () => {
  for (const badImage of [
    'javascript:alert(1)',
    imageUrl.replace('raw.githubusercontent.com', 'raw.githubusercontent.com.evil.example'),
    imageUrl.replace('aws-samples/', 'another-owner/'),
    `${imageUrl}?x=1`,
    `${imageUrl}\n![extra](https://bad)`,
    imageUrl.replace('/pr-582/', '/pr-583/'),
  ])
    assert.throws(() => renderReviewComment(options({ imageUrl: badImage })), /image/i);
  for (const badArtifact of [
    artifactUrl.replace('github.com', 'evil.example'),
    `${artifactUrl}\n@everyone`,
    'https://github.com/aws-samples/sample-collaborative-ai-dlc/issues/1',
  ])
    assert.throws(() => renderReviewComment(options({ artifactUrl: badArtifact })), /artifact/i);
  assert.throws(() => renderReviewComment(options({ headSha: 'main' })), /head SHA/);
  assert.throws(() => renderReviewComment(options({ updatedAt: 'not a date' })), /update time/);
  assert.throws(
    () => renderReviewComment(options({ qualityReport: quality({ pr: assetSha }) })),
    /different revision/,
  );
  assert.throws(
    () => renderReviewComment(options({ impactReport: { ...impact(), headSha: assetSha } })),
    /different revision/,
  );
  assert.throws(
    () => renderReviewComment(options({ impactReport: undefined })),
    /requires an impact report/,
  );
});

test('embedded comparison retains all rows and legends without the standalone introduction', () => {
  const shared = row(0, { kind: 'coverage-decreased' });
  const report = quality({ findings: [shared], improvements: [{ ...shared, kind: 'improved' }] });
  assert.equal(comparisonRows(report).length, 1);
  const embedded = renderComparison(report, { embedded: true });
  assert.deepEqual(tableRows(embedded), tableRows(renderComparison(report)));
  assert.match(embedded, /🟢 Improving · 🟠 Needs attention/);
  assert.doesNotMatch(embedded, /^#|Automated quality|Some coverage data/m);
  assert.match(renderComparison(report), /^# Complexity and test coverage/);
});

test('oversized quality reports retain the map and artifact link with complete, truthful rows', () => {
  const report = quality({
    findings: Array.from({ length: 200 }, (_, index) =>
      row(index, { function: `function${index}_${'x'.repeat(80)}` }),
    ),
  });
  const completeRows = tableRows(renderComparison(report, { embedded: true, headSha }));
  assert.ok(completeRows.join('\n').length > 55000, 'Exercise the former whole-body cutoff');
  const markdown = renderReviewComment(options({ qualityReport: report }));
  assert.ok(markdown.length <= 50000);
  assert.ok(markdown.includes(`![PR impact map](${imageUrl})`));
  assert.ok(markdown.includes(`[Full report artifacts](${artifactUrl})`));
  assert.match(markdown, /\[Isobar\].*by \[r3al1tym\]/);
  assert.match(markdown, /Revision: `aaaaaaa`; updated 2026-10-27 17:28 UTC/);
  assert.match(markdown, /200 flagged functions/);
  const displayed = tableRows(markdown);
  assert.ok(displayed.length > 10 && displayed.length < 200);
  assert.deepEqual(displayed, completeRows.slice(0, displayed.length));
  assert.ok(markdown.includes(`Display truncated: showing ${displayed.length} of 200 functions`));
  assert.ok(markdown.includes(`<summary>Show ${displayed.length - 10} more functions</summary>`));
  assert.ok(displayed.every((line) => line.endsWith(' |') && line.split('|').length === 10));
  let depth = 0;
  for (const [tag] of markdown.matchAll(/<details(?: open)?>|<\/details>/g)) {
    depth += tag.startsWith('</') ? -1 : 1;
    assert.ok(depth >= 0);
  }
  assert.equal(depth, 0);
});

test('small display budgets cannot remove the map, credits, revision or complete-results link', () => {
  const input = options({
    qualityReport: quality({
      findings: Array.from({ length: 40 }, (_, index) => row(index)),
    }),
    maxLength: 3000,
  });
  const markdown = renderReviewComment(input);
  assert.ok(markdown.length <= input.maxLength);
  assert.equal((markdown.match(/<details open>/g) ?? []).length, 2);
  assert.ok(markdown.includes(imageUrl));
  assert.ok(markdown.includes(artifactUrl));
  assert.match(markdown, /Display truncated: showing \d+ of 40 functions/);
  assert.match(markdown, /by \[r3al1tym\]/);
  assert.match(markdown, /Revision: `aaaaaaa`/);
  assert.throws(
    () => renderReviewComment({ ...input, maxLength: 1 }),
    /cannot fit the map and metadata/,
  );
  for (const maxLength of [0, Infinity, NaN, 60001])
    assert.throws(() => renderReviewComment({ ...input, maxLength }), /Invalid.*size budget/);
});

test('available space preserves every row and never introduces a fixed display cap', () => {
  const report = quality({
    findings: Array.from({ length: 40 }, (_, index) => row(index)),
  });
  const normal = renderReviewComment(options({ qualityReport: report }));
  const exact = renderReviewComment(
    options({
      qualityReport: report,
      maxLength: normal.length,
    }),
  );
  assert.equal(exact, normal);
  assert.equal(tableRows(exact).length, 40);
  assert.match(exact, /Show 30 more functions/);
  assert.doesNotMatch(exact, /Display truncated/);
});
