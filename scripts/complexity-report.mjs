// Dependency-free: also used by the trusted CI comment job, which never loads
// modules or Markdown supplied by a pull request.
const cell = (value) =>
  String(value)
    .slice(0, 500)
    .replace(/[&<>|`\r\n@[\]\\!*_~]/g, (character) => `&#${character.charCodeAt(0)};`);
const signed = (value) => `${value > 0 ? '+' : ''}${value}`;
const iconOrder = ['🟣', '🔴', '🟠', '🟢'];
const rowKey = (row) => JSON.stringify([row.path, row.line, row.function, row.before, row.after]);
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

function functionLocation(row, headSha) {
  const text = `${row.path}:${row.line} — ${row.function}`.slice(0, 500);
  const plain = cell(text);
  const location = `${row.path}:${row.line}`;
  if (
    !/^[a-f0-9]{40}$/.test(headSha ?? '') ||
    !Number.isSafeInteger(row.line) ||
    row.line < 1 ||
    location.length >= 500 ||
    row.path.includes('\\') ||
    Array.from(row.path).some((character) => {
      const code = character.charCodeAt(0);
      return code < 32 || code === 127;
    }) ||
    /^[a-z]:/i.test(row.path) ||
    row.path.split('/').some((segment) => !segment || segment === '.' || segment === '..')
  )
    return plain;
  let path;
  try {
    path = row.path
      .split('/')
      .map((segment) =>
        encodeURIComponent(segment).replace(
          /[!'()*]/g,
          (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
        ),
      )
      .join('/');
  } catch {
    return plain;
  }
  return `[${cell(location)}](https://github.com/aws-samples/sample-collaborative-ai-dlc/blob/${headSha}/${path}#L${row.line})${cell(text.slice(location.length))}`;
}

function renderTable(rows, headSha) {
  return [
    '| | File / function | Complexity | Δ | Branch coverage | Δ | Uncovered branches | Depending files |',
    '| --- | --- | ---: | ---: | --- | ---: | ---: | ---: |',
    ...rows.map((row) => {
      const { before, after, change } = row.coverage ?? {};
      const measuredBefore = before?.status === 'measured';
      const measuredAfter = after?.status === 'measured';
      const coverage =
        measuredBefore || measuredAfter
          ? `${measuredBefore ? percent(before) : '—'} → ${measuredAfter ? percent(after) : '—'}`
          : '—';
      const branches =
        measuredBefore || measuredAfter
          ? `${measuredBefore ? before.uncovered : '—'} → ${measuredAfter ? after.uncovered : '—'}`
          : '—';
      const delta = change?.percentagePoints;
      const dependents = row.path.startsWith('frontend/')
        ? 'n/a'
        : (row.dependentFiles ?? 'unknown');
      return `| ${changeIcon(row)} | ${functionLocation(row, headSha)} | ${row.before ?? '—'} → ${row.after} | ${row.delta === null ? '—' : signed(row.delta)} | ${coverage} | ${delta == null ? '—' : signed(Number(delta.toFixed(1)))} | ${branches} | ${dependents} |`;
    }),
  ].join('\n');
}

function renderRows(rows, headSha, maxRows) {
  const ordered = rows.toSorted(
    (a, b) => iconOrder.indexOf(changeIcon(a)) - iconOrder.indexOf(changeIcon(b)),
  );
  const visibleCount = Math.max(10, ordered.filter((row) => changeIcon(row) === '🟣').length);
  const displayed = ordered.slice(0, maxRows);
  const remaining = displayed.slice(visibleCount);
  const lines = displayed.length ? [renderTable(displayed.slice(0, visibleCount), headSha)] : [];
  if (remaining.length)
    lines.push(
      `<details>\n<summary>Show ${remaining.length} more functions</summary>\n\n${renderTable(remaining, headSha)}\n\n</details>`,
    );
  if (displayed.length < ordered.length)
    lines.push(
      `Display truncated: showing ${displayed.length} of ${ordered.length} functions. See the full report artifacts.`,
    );
  return lines.join('\n\n');
}

export function hasIncompleteCoverage(report) {
  const rows = [...report.findings, ...report.improvements];
  const paths = [...report.files, ...rows]
    .map((entry) => entry?.path)
    .filter((path) => typeof path === 'string');
  return (
    rows.some(
      (row) =>
        (row.before !== null && row.coverage?.before?.status !== 'measured') ||
        row.coverage?.after?.status !== 'measured' ||
        row.coverage?.before?.partial ||
        row.coverage?.after?.partial,
    ) ||
    report.files.some((file) =>
      [file?.before, file?.after].some(
        (functions) =>
          Array.isArray(functions) &&
          functions.some((fn) => fn?.coverage?.status !== 'measured' || fn.coverage.partial),
      ),
    ) ||
    (report.coverageNotes ?? []).some(
      (note) =>
        /unknown|failing|interrupted/.test(note) &&
        paths.some((path) =>
          path.startsWith(note.startsWith('Frontend ') ? 'frontend/' : 'lambda/'),
        ),
    )
  );
}

export function comparisonRows(report) {
  const findings = new Set(report.findings.map(rowKey));
  // A complexity improvement can also be a coverage regression; show it once.
  return [...report.findings, ...report.improvements.filter((row) => !findings.has(rowKey(row)))];
}

export function renderComparison(report, { embedded = false, headSha, maxRows = Infinity } = {}) {
  if (maxRows !== Infinity && (!Number.isSafeInteger(maxRows) || maxRows < 0))
    throw new Error('Invalid comparison row limit');
  const rows = comparisonRows(report);
  const lines = embedded
    ? []
    : [
        '# Complexity and test coverage',
        '',
        'Automated quality report using code complexity and test coverage to highlight potential hot spots in this PR.',
        'Review 🟣 and 🔴 items first: consider simplifying the code, improving test coverage, or both. This report is advisory.',
      ];
  const incompleteCoverage = hasIncompleteCoverage(report);
  if (incompleteCoverage && !embedded) {
    lines.push(
      '',
      'Some coverage data is unavailable or incomplete; see the report artifacts for details.',
    );
  }
  if (report.dependencyNote) lines.push('', cell(report.dependencyNote));
  if (rows.length) lines.push('', renderRows(rows, embedded ? headSha : undefined, maxRows));
  if (rows.length || !embedded)
    lines.push(
      '',
      '🟢 Improving · 🟠 Needs attention · 🔴 High risk · 🟣 Highest risk',
      '',
      '— = unavailable · n/a = not applicable · \\* = incomplete tests',
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
