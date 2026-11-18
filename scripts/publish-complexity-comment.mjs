import { lstat, readFile } from 'node:fs/promises';
import { hasIncompleteCoverage, renderComparison } from './complexity-report.mjs';

export const commentMarker = '<!-- complexity-coverage-report -->';
const sha = (value) => typeof value === 'string' && /^[a-f0-9]{40}$/.test(value);
const integer = (value) => Number.isSafeInteger(value) && value >= 0;
const text = (value) => typeof value === 'string' && value.length <= 10000;

export function validCoverage(value) {
  if (value === null) return true;
  if (!value || !['unknown', 'measured'].includes(value.status)) return false;
  if (value.status === 'unknown') return true;
  return (
    (value.partial === undefined || typeof value.partial === 'boolean') &&
    [value.total, value.covered, value.uncovered].every(integer) &&
    value.covered + value.uncovered === value.total &&
    (value.total === 0
      ? value.percent === null
      : Number.isFinite(value.percent) &&
        Math.abs(value.percent - (100 * value.covered) / value.total) < 1e-9)
  );
}

export function validateReport(report) {
  if (
    report?.schemaVersion !== 1 ||
    ![report.base, report.mergeBase, report.pr].every(sha) ||
    !text(report.baseRef) ||
    !report.baseRef ||
    !(report.dependencyNote === undefined || text(report.dependencyNote)) ||
    !integer(report.analyzer?.threshold) ||
    !Array.isArray(report.files) ||
    report.files.length > 100000 ||
    !Array.isArray(report.coverageNotes) ||
    report.coverageNotes.length > 10 ||
    !report.coverageNotes.every(text)
  )
    throw new Error('Invalid report metadata');
  for (const rows of [report.findings, report.improvements]) {
    if (!Array.isArray(rows) || rows.length > 100000) throw new Error('Invalid report rows');
    for (const row of rows) {
      if (
        !text(row.path) ||
        !text(row.function) ||
        !integer(row.line) ||
        !integer(row.after) ||
        !(row.dependentFiles == null || integer(row.dependentFiles)) ||
        !(row.before === null || integer(row.before)) ||
        row.delta !== (row.before === null ? null : row.after - row.before) ||
        ![
          'new-or-unmatched',
          'crossed-threshold',
          'increased',
          'improved',
          'coverage-decreased',
        ].includes(row.kind) ||
        !row.coverage ||
        !validCoverage(row.coverage.before) ||
        !validCoverage(row.coverage.after)
      )
        throw new Error('Invalid report row');
      // Derive deltas from validated counts, not artifact-provided Markdown or deltas.
      const { before, after } = row.coverage;
      row.coverage.change =
        before?.status === 'measured' && after?.status === 'measured'
          ? {
              percentagePoints:
                before.percent === null || after.percent === null
                  ? null
                  : after.percent - before.percent,
              uncovered: after.uncovered - before.uncovered,
            }
          : null;
    }
  }
  return report;
}

// Select the latest attempt of each producer, not the consumer's attempt.
// A producer that reran and failed must not fall back to its previous artifact.
export async function qualityArtifactNames({ github, repo, runId, attempt }) {
  const jobs = await github.paginate(github.rest.actions.listJobsForWorkflowRun, {
    ...repo,
    run_id: runId,
    filter: 'all',
    per_page: 100,
  });
  const names = {};
  for (const [role, jobName, prefix] of [
    ['base', 'coverage-base', 'coverage-base'],
    ['pr', 'coverage-pr', 'coverage-pr'],
    ['report', 'report', 'pr-quality'],
  ]) {
    const producer = jobs
      .filter((job) => job.name === jobName && job.run_attempt <= attempt)
      .toSorted((a, b) => b.run_attempt - a.run_attempt)[0];
    names[role] =
      producer && producer.conclusion !== 'skipped' ? `${prefix}-${producer.run_attempt}` : '';
  }
  return names;
}

// Same-repository PRs use their pinned scripts; workflow_run uses default-branch code.
// PR identity comes from GitHub; artifacts cannot select the destination.
export async function publishComplexityComment({
  github,
  context,
  reportPath,
  attempt = Number(process.env.GITHUB_RUN_ATTEMPT),
  warn = console.warn,
}) {
  let run = context.payload.workflow_run;
  const repo = context.repo;
  let candidates;
  if (context.eventName === 'pull_request') {
    const pr = context.payload.pull_request;
    if (pr.head.repo?.id !== context.payload.repository.id || context.actor === 'dependabot[bot]')
      return;
    run = {
      event: 'pull_request',
      name: 'PR Quality',
      id: context.runId,
      run_attempt: attempt,
      repository: context.payload.repository,
      head_sha: pr.head.sha,
      head_repository: pr.head.repo,
    };
    candidates = [pr];
  }
  if (
    !run ||
    run.event !== 'pull_request' ||
    run.name !== 'PR Quality' ||
    run.repository.id !== context.payload.repository.id
  )
    return;
  if (!candidates) {
    const pulls = await github.paginate(github.rest.pulls.list, {
      ...repo,
      state: 'open',
      per_page: 100,
    });
    candidates = pulls.filter(
      (pr) => pr.head.sha === run.head_sha && pr.head.repo?.id === run.head_repository?.id,
    );
  }
  let report;
  try {
    const stat = await lstat(reportPath);
    if (!stat.isFile() || stat.size > 20 * 1024 * 1024)
      throw new Error('Report must be a regular file under 20 MiB');
    report = validateReport(JSON.parse(await readFile(reportPath, 'utf8')));
  } catch (error) {
    warn(`Quality report unavailable: ${error.message}`);
  }
  for (const candidate of candidates) {
    // Refresh just before writing; do not publish an old commit or target base.
    const { data: pr } = await github.rest.pulls.get({ ...repo, pull_number: candidate.number });
    if (
      pr.state !== 'open' ||
      pr.head.sha !== run.head_sha ||
      pr.head.repo?.id !== run.head_repository?.id
    )
      continue;
    if (report && report.pr !== pr.head.sha) continue;
    const comments = await github.paginate(github.rest.issues.listComments, {
      ...repo,
      issue_number: pr.number,
      per_page: 100,
    });
    const existing = comments.find(
      (comment) =>
        comment.user?.login === 'github-actions[bot]' &&
        comment.user?.type === 'Bot' &&
        comment.body?.startsWith(commentMarker),
    );
    const previous = existing?.body.match(/<!-- quality-run:(\d+):(\d+) -->/);
    const olderRun =
      previous &&
      (Number(previous[1]) > run.id ||
        (Number(previous[1]) === run.id && Number(previous[2]) > run.run_attempt));
    const combinedReport = existing?.body.includes('<!-- review-assets:');
    if (olderRun && !combinedReport) continue;
    if (combinedReport) {
      const { enrichReviewSignals } = await import('./pr-impact/publish.mjs');
      if (await enrichReviewSignals({ github, context, pr, run, report, existing, warn })) continue;
    }
    if (olderRun) continue;
    const url = `https://github.com/${repo.owner}/${repo.repo}/actions/runs/${run.id}`;
    let content = '# Complexity and test coverage\n\nQuality report unavailable — see CI logs.';
    if (report) {
      let sameBase = report.baseRef === pr.base.ref;
      if (sameBase) {
        // Resolve the actual target tip: pulls.get can return a stale base.sha.
        const { data: comparison } = await github.rest.repos.compareCommitsWithBasehead({
          ...repo,
          basehead: `${pr.base.ref}...${pr.head.sha}`,
          per_page: 1,
        });
        sameBase = comparison.merge_base_commit.sha === report.mergeBase;
      }
      const noResults =
        report.findings.length === 0 &&
        report.improvements.length === 0 &&
        !hasIncompleteCoverage(report) &&
        !report.dependencyNote;
      if (sameBase && (report.files.length === 0 || noResults)) {
        if (existing) {
          await github.rest.issues.deleteComment({ ...repo, comment_id: existing.id });
        }
        continue;
      }
      content = sameBase
        ? renderComparison(report)
        : `# Complexity and test coverage\n\nThe target branch or merge base changed. Push an updated branch to generate a fresh comparison for \`${pr.head.sha}\`.`;
    }
    const truncated = content.slice(0, 55000);
    const truncatedRows = truncated.slice(0, truncated.lastIndexOf('\n'));
    const closeDetails =
      truncatedRows.includes('<details>') && !truncatedRows.includes('</details>')
        ? '\n\n</details>'
        : '';
    const preview =
      content.length <= 55000
        ? content
        : `${truncatedRows}${closeDetails}\n\nDisplay truncated; see the full report artifact.`;
    const body = `${commentMarker}\n<!-- quality-run:${run.id}:${run.run_attempt} -->\n${preview}\n[CI run and full report artifacts](${url})`;
    if (existing) {
      await github.rest.issues.updateComment({ ...repo, comment_id: existing.id, body });
    } else {
      await github.rest.issues.createComment({ ...repo, issue_number: pr.number, body });
    }
  }
}
