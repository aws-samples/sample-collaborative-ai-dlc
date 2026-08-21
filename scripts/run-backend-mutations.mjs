import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { calculateMutationTestMetrics } from 'mutation-testing-metrics';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const lambdaRoot = join(root, 'lambda');
const dryRun = process.argv.includes('--dry-run');
const includeStatic = process.argv.includes('--include-static');
const scopeArgument = process.argv.find((argument) => argument.startsWith('--scope='));
const requestedScope = scopeArgument?.slice('--scope='.length);
const roundScore = (value) => (Number.isFinite(value) ? Number(value.toFixed(2)) : null);

const lambdaDirectories = readdirSync(lambdaRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory() && entry.name !== 'node_modules')
  .map((entry) => entry.name)
  .toSorted();
const testedScopes = lambdaDirectories.filter((name) => existsSync(join(lambdaRoot, name, 'test')));
const untestedDirectories = lambdaDirectories.filter(
  (name) => !existsSync(join(lambdaRoot, name, 'test')),
);

const sourceBytes = (directory) => {
  const entries = readdirSync(directory, { withFileTypes: true });
  return entries.reduce((total, entry) => {
    if (entry.name === 'node_modules' || entry.name === 'test') return total;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return total + sourceBytes(path);
    return entry.name.endsWith('.js') ? total + statSync(path).size : total;
  }, 0);
};

const sourceBytesByScope = new Map(
  testedScopes.map((scope) => [scope, sourceBytes(join(lambdaRoot, scope))]),
);
const orderedTestedScopes = testedScopes.toSorted(
  (left, right) =>
    sourceBytesByScope.get(left) - sourceBytesByScope.get(right) || left.localeCompare(right),
);
const availableScopes = [...orderedTestedScopes, 'untested'];

if (requestedScope && !availableScopes.includes(requestedScope)) {
  console.error(
    `Unknown mutation scope "${requestedScope}". Expected one of: ${availableScopes.join(', ')}`,
  );
  process.exit(2);
}

const scopes = requestedScope ? [requestedScope] : availableScopes;
const strykerBin = join(root, 'node_modules', '.bin', 'stryker');
const failures = [];

for (const scope of scopes) {
  console.log(`\n=== Backend mutation scope: ${scope} ===\n`);
  if (!dryRun) {
    rmSync(join(root, 'reports', 'mutation', `${scope}.json`), { force: true });
    rmSync(join(root, 'reports', 'mutation', `${scope}.html`), { force: true });
  }
  const args = ['run'];
  if (dryRun) args.push('--dryRunOnly');
  const result = spawnSync(strykerBin, args, {
    cwd: root,
    env: {
      ...process.env,
      STRYKER_SCOPE: scope,
      STRYKER_UNTESTED_DIRECTORIES: untestedDirectories.join(','),
      STRYKER_IGNORE_STATIC: String(!includeStatic),
    },
    stdio: 'inherit',
  });
  if (result.signal) {
    console.error(`Mutation scope "${scope}" interrupted by ${result.signal}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    failures.push(scope);
    console.error(`Mutation scope "${scope}" failed; continuing with the remaining scopes.`);
  }
}

if (!dryRun) {
  const rows = scopes.flatMap((scope) => {
    const reportPath = join(root, 'reports', 'mutation', `${scope}.json`);
    if (!existsSync(reportPath)) return [];
    const report = JSON.parse(readFileSync(reportPath, 'utf8'));
    const metrics = calculateMutationTestMetrics(report).systemUnderTestMetrics.metrics;
    return [
      {
        scope,
        mutants: metrics.totalMutants,
        killed: metrics.killed + metrics.timeout,
        survived: metrics.survived,
        noCoverage: metrics.noCoverage,
        score: roundScore(metrics.mutationScore),
        coveredScore: roundScore(metrics.mutationScoreBasedOnCoveredCode),
        otherStatuses: Object.fromEntries(
          [
            ['Pending', metrics.pending],
            ['RuntimeError', metrics.runtimeErrors],
            ['CompileError', metrics.compileErrors],
            ['Ignored', metrics.ignored],
          ].filter(([, count]) => count > 0),
        ),
      },
    ];
  });
  const summaryPath = join(root, 'reports', 'mutation', 'summary.json');
  mkdirSync(dirname(summaryPath), { recursive: true });
  writeFileSync(
    summaryPath,
    `${JSON.stringify({ scopes: rows, failedScopes: failures }, null, 2)}\n`,
  );
  console.table(rows);
  console.log(`Mutation summary: ${relative(root, summaryPath)}`);
}

if (failures.length > 0) {
  console.error(`Mutation failed for: ${failures.join(', ')}`);
  process.exitCode = 1;
}
