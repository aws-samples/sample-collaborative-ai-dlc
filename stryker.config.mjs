const scope = process.env.STRYKER_SCOPE;
if (!scope) {
  throw new Error('STRYKER_SCOPE is required; run mutation tests through the npm scripts');
}

const untestedDirectories = (process.env.STRYKER_UNTESTED_DIRECTORIES ?? '')
  .split(',')
  .filter(Boolean);
const explicitMutate = process.env.STRYKER_MUTATE_FILES
  ? JSON.parse(process.env.STRYKER_MUTATE_FILES)
  : null;
const mutate =
  explicitMutate ??
  (scope === 'untested'
    ? untestedDirectories.map((directory) => `lambda/${directory}/**/*.js`)
    : [`lambda/${scope}/**/*.js`, `!lambda/${scope}/test/**`]);
const reportBase = process.env.STRYKER_REPORT_BASE ?? `reports/mutation/${scope}`;
const incremental = process.env.STRYKER_INCREMENTAL !== 'false';

export default {
  $schema: './node_modules/@stryker-mutator/core/schema/stryker-schema.json',
  testRunner: 'vitest',
  vitest: {
    configFile: 'vitest.mutation.config.js',
    related: scope !== 'untested',
  },
  mutate,
  coverageAnalysis: 'perTest',
  concurrency: 4,
  disableTypeChecks: 'lambda/**/*.js',
  ignoreStatic: process.env.STRYKER_IGNORE_STATIC === 'true',
  ignorePatterns: [
    '.cache/**',
    '.claude/**',
    '.codegraph/**',
    '.idea/**',
    '.kiro/**',
    '.opencode/**',
    '.venv/**',
    '.worktrees/**',
    'frontend/**',
    'site/**',
  ],
  incremental,
  ...(incremental ? { incrementalFile: `${reportBase}-incremental.json` } : {}),
  reporters: ['clear-text', 'progress', 'html', 'json'],
  clearTextReporter: {
    reportTests: false,
    reportMutants: false,
  },
  htmlReporter: {
    fileName: `${reportBase}.html`,
  },
  jsonReporter: {
    fileName: `${reportBase}.json`,
  },
  thresholds: {
    high: 80,
    low: 60,
    break: null,
  },
};
