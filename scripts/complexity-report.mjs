// Dependency-free: also used by the trusted CI comment job, which never loads
// modules or Markdown supplied by a pull request.
const cell = (value) =>
  String(value)
    .slice(0, 500)
    .replace(/[&<>|`\r\n@[\]\\!*_~]/g, (character) => `&#${character.charCodeAt(0)};`);
const signed = (value) => `${value > 0 ? '+' : ''}${value}`;
const uncovered = (value) => (value?.status === 'measured' ? value.uncovered : '?');
const percent = (coverage) =>
  coverage?.status !== 'measured'
    ? 'unknown'
    : coverage.percent === null
      ? 'n/a'
      : `${coverage.percent.toFixed(1)}%${coverage.partial ? '*' : ''}`;

function currentRiskIcon(row) {
  let level = row.after > 100 ? 3 : row.after > 50 ? 2 : row.after > 15 ? 1 : 0;
  const coverage = row.coverage?.after;
  if (coverage?.status === 'measured' && coverage.percent != null && coverage.percent < 50) {
    level = Math.min(3, level + 1);
  }
  return ['🟢', '🟠', '🔴', '🟣'][level];
}

function complexityCoverageIcon(row) {
  const coverageDelta = row.coverage?.change?.percentagePoints;
  if (row.before == null || row.delta == null) return currentRiskIcon(row);

  // Normalize the two different units before balancing mixed changes.
  // Frontend changes use a higher floor before flagging a large regression.
  const floor = row.path.startsWith('frontend/') ? 10 : 5;
  const complexityWorsening = row.delta / Math.max(floor, row.before * 0.2);
  const coverageWorsening = -(coverageDelta ?? 0) / 10;
  if (
    complexityWorsening <= 0 &&
    coverageWorsening <= 0 &&
    (complexityWorsening < 0 || coverageWorsening < 0)
  )
    return '🟢';
  if (complexityWorsening >= 1 && coverageWorsening >= 1) return '🟣';
  return complexityWorsening + coverageWorsening >= 1 ? '🔴' : '🟠';
}

export function changeIcon(row) {
  const icon = complexityCoverageIcon(row);
  const { after, change } = row.coverage ?? {};
  const weakCoverage = after?.status === 'measured' && after.percent != null && after.percent < 50;
  const regressingCoverage = change?.percentagePoints < 0 || change?.uncovered > 0;
  // Keep improvements green. Coupling amplifies an existing warning, not debt alone.
  if (icon !== '🟢' && row.dependentFiles > 10 && (weakCoverage || regressingCoverage)) {
    return icon === '🟠' ? '🔴' : '🟣';
  }
  return icon;
}

function renderRows(rows) {
  return [
    '| | File / function | Complexity | Δ | Branch coverage | Δ | Uncovered branches | Depending files |',
    '| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |',
    ...rows.slice(0, 20).map((row) => {
      const { before, after, change } = row.coverage ?? {};
      const coverage = `${percent(before)} → ${percent(after)}`;
      const delta = change?.percentagePoints;
      const dependents = row.path.startsWith('frontend/')
        ? 'n/a'
        : (row.dependentFiles ?? 'unknown');
      return `| ${changeIcon(row)} | ${cell(`${row.path}:${row.line} — ${row.function}`)} | ${row.before ?? '—'} → ${row.after} | ${row.delta === null ? '—' : signed(row.delta)} | ${coverage} | ${delta == null ? '—' : signed(Number(delta.toFixed(1)))} | ${uncovered(before)} → ${uncovered(after)} | ${dependents} |`;
    }),
    ...(rows.length > 20
      ? [`\nShowing 20 of ${rows.length}; the JSON report contains every result.`]
      : []),
  ].join('\n');
}

export function renderComparison(report) {
  const lines = [
    '# Complexity and test coverage',
    '',
    `Analyzed ${report.files.length} source files changed by this PR. Advisory threshold: ${report.analyzer.threshold}.`,
    '',
    `${report.findings.length} new/unmatched or worsening functions above the threshold.`,
  ];
  for (const note of report.coverageNotes ?? []) lines.push('', cell(note));
  if (report.dependencyNote) lines.push('', cell(report.dependencyNote));
  if (report.findings.length) lines.push('', renderRows(report.findings));
  if (report.improvements.length) {
    lines.push(
      '',
      `## Complexity improvements (${report.improvements.length})`,
      '',
      renderRows(report.improvements),
    );
  }
  lines.push(
    '',
    '🟢 Improving · 🟠 Needs attention · 🔴 High risk · 🟣 Highest risk',
    '',
    'unknown = unavailable · n/a = not applicable · \\* = incomplete tests',
    '',
  );
  return lines.join('\n');
}

export function renderComplexityDetails(report) {
  const lines = [
    '# Complexity details',
    '',
    'All functions in PR-changed files, including those below the advisory threshold.',
    '',
    'unknown = unavailable · n/a = no branches · \\* = incomplete tests',
  ];
  for (const note of report.coverageNotes ?? []) lines.push('', cell(note));
  if (!report.files.length) lines.push('', 'No source files changed.');
  for (const file of report.files) {
    lines.push('', `## ${cell(file.path)}`);
    if (file.previousPath && file.previousPath !== file.path) {
      lines.push('', `Previously: ${cell(file.previousPath)}`);
    }
    lines.push(
      '',
      '| Revision | Function | Line | Complexity | Branch coverage | Uncovered branches |',
      '| --- | --- | ---: | ---: | ---: | ---: |',
    );
    for (const [revision, functions] of [
      ['Base', file.before],
      ['PR', file.after],
    ]) {
      for (const fn of functions) {
        lines.push(
          `| ${revision} | ${cell(fn.name)} | ${fn.line} | ${fn.score} | ${percent(fn.coverage)} | ${uncovered(fn.coverage)} |`,
        );
      }
    }
    if (!file.before.length && !file.after.length) lines.push('', 'No functions.');
  }
  return `${lines.join('\n')}\n`;
}

export function renderDependencyDetails(report) {
  const lines = [
    '# Depending files',
    '',
    'Direct production importers at the PR commit. Backend only; excludes tests and external callers.',
  ];
  if (!report.dependencies.length) lines.push('', 'No source files changed.');
  for (const file of report.dependencies) {
    lines.push('', `## ${cell(file.path)}`, '');
    if (file.importers === null) lines.push(cell(file.reason));
    else if (!file.importers.length) lines.push('No direct production importers.');
    else lines.push(...file.importers.map((path) => `- ${cell(path)}`));
  }
  return `${lines.join('\n')}\n`;
}
