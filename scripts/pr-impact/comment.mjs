// Dependency-free: imported by the trusted publisher after report validation.
import { comparisonRows, hasIncompleteCoverage, renderComparison } from '../complexity-report.mjs';

const repository = 'aws-samples/sample-collaborative-ai-dlc';
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const escape = (value) =>
  String(value)
    .slice(0, 500)
    .replace(/[&<>|`\r\n@[\]\\!*_~]/g, (character) => `&#${character.charCodeAt(0)};`);
const plural = (count, noun) => `${count} ${noun}${count === 1 ? '' : 's'}`;
const count = (value) => {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error('Invalid impact count');
  return value;
};

function validateUrls(imageUrl, artifactUrl) {
  const rawPrefix = `https://raw.githubusercontent.com/${repository}/`;
  const artifactPrefix = `https://github.com/${repository}/actions/runs/`;
  if (
    imageUrl != null &&
    (typeof imageUrl !== 'string' ||
      !imageUrl.startsWith(rawPrefix) ||
      !/^[a-f0-9]{40}\/pr-[1-9]\d*\/map\.png$/.test(imageUrl.slice(rawPrefix.length)))
  )
    throw new Error('Invalid impact image URL');
  if (
    artifactUrl != null &&
    (typeof artifactUrl !== 'string' ||
      !artifactUrl.startsWith(artifactPrefix) ||
      !/^[1-9]\d*(?:#artifacts)?$/.test(artifactUrl.slice(artifactPrefix.length)))
  )
    throw new Error('Invalid report artifact URL');
}

function coverageSummary(report, rows) {
  const measurements = (revision) => {
    const values = report.files.flatMap((file) =>
      Array.isArray(file[revision]) ? file[revision].map((fn) => fn?.coverage) : [],
    );
    return values.length
      ? values
      : rows.filter((row) => row[revision] !== null).map((row) => row.coverage?.[revision]);
  };
  const before = measurements('before');
  const after = measurements('after');
  const measuredBefore = before.some((value) => value?.status === 'measured');
  const measuredAfter = after.some((value) => value?.status === 'measured');
  const partial = [...before, ...after].some((value) => value?.partial);
  if (!measuredBefore && !measuredAfter)
    return 'Coverage unavailable; test protection cannot be compared.';
  if (!measuredBefore)
    return `Coverage: ${partial ? 'partial PR measurements' : 'PR measurements only'}; no comparable baseline, so no before/after comparison.`;
  if (!measuredAfter)
    return `Coverage: ${partial ? 'partial baseline measurements' : 'baseline measurements only'}; PR coverage unavailable, so no before/after comparison.`;
  const unavailable =
    [...before, ...after].some((value) => value?.status !== 'measured') ||
    report.coverageNotes?.some(
      (note) =>
        /unknown/.test(note) &&
        report.files.some((file) =>
          file.path.startsWith(note.startsWith('Frontend ') ? 'frontend/' : 'lambda/'),
        ),
    );
  if (partial)
    return `Coverage: partial measurements${unavailable ? '; some data unavailable' : ''}. Available deltas may reflect incomplete tests.`;
  if (unavailable) return 'Coverage: before/after measurements available; some data unavailable.';
  return 'Coverage: before/after measurements available for the analyzed functions.';
}

function qualitySection(report, headSha, maxRows = Infinity) {
  const rows = comparisonRows(report);
  const improvements = rows.length - report.findings.length;
  return [
    '<details open>',
    '<summary>Complexity and test coverage</summary>',
    '',
    `${plural(report.files.length, 'changed JS/TS file')} analyzed · ${plural(report.findings.length, 'flagged function')}${improvements ? ` · ${plural(improvements, 'improvement')}` : ''}.`,
    coverageSummary(report, rows),
    '',
    renderComparison(report, { embedded: true, headSha, maxRows }).trim(),
    '',
    '</details>',
  ].join('\n');
}

function emptyQualityScope(impactReport) {
  const paths = (impactReport?.files ?? impactReport?.evidence?.changes ?? []).map(
    (file) => file.path,
  );
  const notes = ['No production JS/TS in scope.'];
  if (paths.some((path) => /^(?:\.github|scripts)\//.test(path)))
    notes.push('CI and tooling changes are outside these production JS/TS metrics.');
  if (paths.some((path) => path.startsWith('terraform/') || /\.tf(?:\.json)?$/.test(path)))
    notes.push('The quality analyzer does not assess Terraform or IAM changes.');
  return notes.join(' ');
}

function mapSection(report, imageUrl, revision) {
  const { annotations, summary } = report.evidence;
  if (!Array.isArray(annotations) || annotations.length > 2)
    throw new Error('Invalid impact annotations');
  const signals = annotations.map(
    (annotation) =>
      `- ${escape(annotation.key)}: ${escape(annotation.path)} — ${escape(annotation.detail)}.`,
  );
  signals.push(
    `- Total static reach: ${count(summary.productionReachFiles)} unchanged production files; ${count(summary.testReachFiles)} unchanged test files.`,
  );
  if (count(summary.unavailableReachFiles))
    signals.push(
      `- Static reach unavailable for ${plural(summary.unavailableReachFiles, 'changed file')}.`,
    );
  signals.push(`- ${revision}`);
  return [
    '<details open>',
    '<summary>Isobar repository map</summary>',
    '',
    `![PR impact map](${imageUrl})`,
    '',
    'This fixed repository map locates changed files and their possible reach through static links.',
    'Red marks changed files; green marks static links, not proven runtime impact or a risk grade.',
    '',
    '[Isobar](https://github.com/r3al1tym/isobar) by [r3al1tym](https://github.com/r3al1tym).',
    '',
    '<details>',
    '<summary>Signals</summary>',
    '',
    ...signals,
    '',
    '</details>',
    '',
    '<details>',
    '<summary>Legend</summary>',
    '',
    '- ○ modified · ◇ added · × deleted. Blue markers: tests; gray markers: documentation.',
    '- Solid green: import-linked name matches. Dotted green: broader file-level import fallback.',
    '',
    '</details>',
    '',
    '</details>',
  ].join('\n');
}

/**
 * Compose validated quality/map data. The publisher owns artifact validation,
 * PR identity, asset publication and comment updates; this function has no I/O.
 */
export function renderReviewComment({
  qualityReport,
  impactReport,
  imageUrl,
  headSha,
  updatedAt,
  artifactUrl,
  maxLength = 50000,
}) {
  if (!Number.isSafeInteger(maxLength) || maxLength < 1 || maxLength > 60000)
    throw new Error('Invalid review comment size budget');
  if (!sha(headSha)) throw new Error('Invalid review head SHA');
  if (qualityReport && qualityReport.pr !== headSha)
    throw new Error('Quality report belongs to a different revision');
  if (impactReport && impactReport.headSha !== headSha)
    throw new Error('Impact report belongs to a different revision');
  validateUrls(imageUrl, artifactUrl);
  if (imageUrl && !impactReport) throw new Error('Impact image requires an impact report');
  if (imageUrl && !imageUrl.endsWith(`/pr-${impactReport.prNumber}/map.png`))
    throw new Error('Impact image belongs to a different PR');
  const date = new Date(updatedAt);
  if (!Number.isFinite(date.getTime())) throw new Error('Invalid review update time');
  const revision = `Revision: \`${headSha.slice(0, 7)}\`; updated ${date.toISOString().slice(0, 16).replace('T', ' ')} UTC.`;
  const hasQualityScope = qualityReport?.files.length > 0;
  const hasQuality =
    hasQualityScope &&
    (comparisonRows(qualityReport).length > 0 ||
      hasIncompleteCoverage(qualityReport) ||
      Boolean(qualityReport.dependencyNote));
  const hasMap = Boolean(impactReport && imageUrl);
  if (qualityReport && !hasQuality && !hasMap) return '';
  const lines = ['**Automatically computed PR review signals (deterministic)**', ''];
  let qualityIndex;
  if (hasQuality) {
    lines.push(
      'Complexity and branch coverage help focus review on functions and their tests; these signals are advisory.',
      '',
      qualitySection(qualityReport, headSha),
    );
    qualityIndex = lines.length - 1;
  } else {
    lines.push(
      qualityReport
        ? hasQualityScope
          ? `${plural(qualityReport.files.length, 'changed JS/TS file')} analyzed; no flagged functions, improvements or analysis warnings.`
          : emptyQualityScope(impactReport)
        : 'Quality report unavailable; this is not a clean result. See the report artifacts.',
    );
  }
  if (hasMap) lines.push('', '---', '', mapSection(impactReport, imageUrl, revision));
  else {
    if (impactReport) lines.push('', 'Isobar map unavailable; see the report artifacts.');
    lines.push('', revision);
  }
  if (artifactUrl) lines.push('', `[Full report artifacts](${artifactUrl})`);
  const render = () => `${lines.join('\n')}\n`;
  const complete = render();
  if (complete.length <= maxLength) return complete;
  if (hasQuality) {
    // Re-render only complete rows. The fixed map, footer and disclosures are
    // reserved in every candidate instead of cutting arbitrary Markdown.
    let low = 0;
    let high = comparisonRows(qualityReport).length;
    let bounded;
    while (low <= high) {
      const maxRows = Math.floor((low + high) / 2);
      lines[qualityIndex] = qualitySection(qualityReport, headSha, maxRows);
      const candidate = render();
      if (candidate.length <= maxLength) {
        bounded = candidate;
        low = maxRows + 1;
      } else high = maxRows - 1;
    }
    if (bounded) return bounded;
  }
  throw new Error('Review comment size budget cannot fit the map and metadata');
}
