import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateMetrics, calculateMutationTestMetrics } from 'mutation-testing-metrics';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lambdaRoot = join(root, 'lambda');
const reportRoot = join(root, 'reports', 'mutation', 'pr');
const dryRun = process.argv.includes('--dry-run');
const reportOnly = process.argv.includes('--report-only');
const executionIncomplete = process.env.MUTATION_EXECUTION_INCOMPLETE === 'true';
const workflowUrl = process.env.MUTATION_WORKFLOW_URL;
const argument = (name) =>
  process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3);
const base = argument('base') ?? 'origin/main';
const explicitFiles = argument('files');
const percent = (metrics) =>
  metrics.totalMutants === 0 ? 'n/a' : `${metrics.mutationScore.toFixed(1)}%`;

const lambdaDirectories = readdirSync(lambdaRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
  .map((entry) => entry.name);
const untestedDirectories = lambdaDirectories.filter(
  (name) => !existsSync(join(lambdaRoot, name, 'test')),
);

const diffFiles = () => {
  const output = execFileSync(
    'git',
    ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`, '--', 'lambda'],
    { cwd: root, encoding: 'utf8' },
  );
  return output.split('\n');
};

const requestedFiles = explicitFiles ? explicitFiles.split(',') : diffFiles();
const changedFiles = [
  ...new Set(
    requestedFiles
      .map((file) => file.trim())
      .filter(Boolean)
      .filter(
        (file) =>
          file.startsWith('lambda/') &&
          file.endsWith('.js') &&
          !file.includes('/test/') &&
          !file.includes('/.build/') &&
          !file.includes('/node_modules/') &&
          existsSync(join(root, file)),
      ),
  ),
].toSorted();

mkdirSync(reportRoot, { recursive: true });

const writeEmptySummary = () => {
  const message = [
    '## Backend mutation testing',
    '',
    '> Informational only. No backend production JavaScript file changed in this pull request.',
    '',
  ].join('\n');
  writeFileSync(join(reportRoot, 'summary.md'), message);
  writeFileSync(
    join(reportRoot, 'summary.json'),
    `${JSON.stringify({ changedFiles: [], scopes: [], failedScopes: [] }, null, 2)}\n`,
  );
};

if (changedFiles.length === 0) {
  writeEmptySummary();
  console.log('No changed backend production JavaScript files to mutate.');
  process.exit(0);
}

const filesByScope = new Map();
for (const file of changedFiles) {
  const directory = file.split('/')[1];
  const scope = existsSync(join(lambdaRoot, directory, 'test')) ? directory : 'untested';
  const files = filesByScope.get(scope) ?? [];
  files.push(file);
  filesByScope.set(scope, files);
}

const strykerBin = join(root, 'node_modules', '.bin', 'stryker');
const failures = [];

if (!reportOnly) {
  for (const [scope, files] of filesByScope) {
    console.log(`\n=== Changed backend mutation scope: ${scope} ===`);
    for (const file of files) console.log(`- ${file}`);
    console.log('');

    const reportBase = `reports/mutation/pr/${scope}`;
    const args = ['run'];
    if (dryRun) args.push('--dryRunOnly');
    const result = spawnSync(strykerBin, args, {
      cwd: root,
      env: {
        ...process.env,
        STRYKER_SCOPE: scope,
        STRYKER_UNTESTED_DIRECTORIES: untestedDirectories.join(','),
        STRYKER_MUTATE_FILES: JSON.stringify(files),
        STRYKER_REPORT_BASE: reportBase,
        STRYKER_INCREMENTAL: 'false',
        STRYKER_IGNORE_STATIC: 'true',
      },
      stdio: 'inherit',
    });

    if (result.signal) {
      failures.push(scope);
      console.error(`Mutation scope "${scope}" was interrupted by ${result.signal}.`);
      continue;
    }
    if (result.status !== 0) {
      failures.push(scope);
      console.error(`Mutation scope "${scope}" failed; continuing with the remaining scopes.`);
    }
  }
}

if (dryRun) {
  process.exitCode = failures.length > 0 ? 1 : 0;
} else {
  const scopeRows = [];
  const fileRows = [];
  const noteworthyMutants = [];
  const missingScopes = [];

  for (const [scope, files] of filesByScope) {
    const reportPath = join(reportRoot, `${scope}.json`);
    if (!existsSync(reportPath)) {
      missingScopes.push(scope);
      continue;
    }
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const rootMetrics = calculateMutationTestMetrics(report).systemUnderTestMetrics.metrics;
    scopeRows.push({ scope, files: files.length, ...rootMetrics });

    for (const [fileName, fileResult] of Object.entries(report.files ?? {})) {
      const metrics = calculateMetrics({ [fileName]: fileResult }).metrics;
      fileRows.push({ file: fileName, ...metrics });
      for (const mutant of fileResult.mutants ?? []) {
        if (mutant.status === 'Survived' || mutant.status === 'NoCoverage') {
          noteworthyMutants.push({
            file: fileName,
            line: mutant.location?.start?.line ?? null,
            status: mutant.status,
            mutator: mutant.mutatorName,
          });
        }
      }
    }
  }

  const markdown = [
    '## Backend mutation testing',
    '',
    '> Informational only. Entire changed backend files are mutated; surviving mutants may expose pre-existing test weaknesses and do not fail the pull request.',
    '',
    `Changed production files: **${changedFiles.length}**`,
    '',
    '| Scope | Files | Mutants | Killed | Survived | No coverage | Score |',
    '| --- | ---: | ---: | ---: | ---: | ---: | ---: |',
    ...scopeRows.map(
      (row) =>
        `| \`${row.scope}\` | ${row.files} | ${row.totalMutants} | ${row.killed + row.timeout} | ${row.survived} | ${row.noCoverage} | ${percent(row)} |`,
    ),
    '',
    '### Changed files',
    '',
    '| File | Mutants | Survived | No coverage | Score |',
    '| --- | ---: | ---: | ---: | ---: |',
    ...fileRows
      .toSorted((left, right) => left.file.localeCompare(right.file))
      .map(
        (row) =>
          `| \`${row.file}\` | ${row.totalMutants} | ${row.survived} | ${row.noCoverage} | ${percent(row)} |`,
      ),
  ];

  if (noteworthyMutants.length > 0) {
    const displayed = noteworthyMutants
      .toSorted(
        (left, right) =>
          left.file.localeCompare(right.file) ||
          (left.line ?? 0) - (right.line ?? 0) ||
          left.status.localeCompare(right.status),
      )
      .slice(0, 30);
    markdown.push(
      '',
      '### Review attention',
      '',
      ...displayed.map(
        (mutant) =>
          `- \`${mutant.file}${mutant.line ? `:${mutant.line}` : ''}\`: **${mutant.status}** (${mutant.mutator})`,
      ),
    );
    if (noteworthyMutants.length > displayed.length) {
      markdown.push(
        `- ${noteworthyMutants.length - displayed.length} additional survivor(s) or uncovered mutant(s) are available in the HTML reports.`,
      );
    }
  }

  if (failures.length > 0) {
    markdown.push(
      '',
      `Mutation execution failed for: ${failures.map((scope) => `\`${scope}\``).join(', ')}.`,
    );
  }
  if (executionIncomplete || missingScopes.length > 0) {
    markdown.push(
      '',
      '> The 30-minute pilot limit was reached or execution did not complete. Results above are partial.',
    );
    if (missingScopes.length > 0) {
      markdown.push(
        `No report was produced for: ${missingScopes.map((scope) => `\`${scope}\``).join(', ')}.`,
      );
    }
  }
  markdown.push(
    '',
    workflowUrl
      ? `Detailed HTML and JSON reports are available in the [workflow artifact](${workflowUrl}).`
      : 'Detailed HTML and JSON reports are attached to the workflow run.',
    '',
  );

  const summary = {
    changedFiles,
    scopes: scopeRows,
    files: fileRows,
    noteworthyMutants,
    failedScopes: failures,
    missingScopes,
    executionIncomplete,
  };
  writeFileSync(join(reportRoot, 'summary.md'), markdown.join('\n'));
  writeFileSync(join(reportRoot, 'summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`Mutation PR summary: ${relative(root, join(reportRoot, 'summary.md'))}`);

  if (failures.length > 0) process.exitCode = 1;
}
