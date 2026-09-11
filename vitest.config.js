import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';

const lambdaRoot = new URL('./lambda/', import.meta.url);
const lambdas = readdirSync(fileURLToPath(lambdaRoot)).filter((name) =>
  existsSync(new URL(`${name}/test`, lambdaRoot)),
);

const setupFiles = [fileURLToPath(new URL('./test/setup.js', import.meta.url))];
// One gremlin-server + one DynamoDB Local testcontainer are started for the whole
// vitest run and shared across every project. Per-file PartitionStrategy isolates
// graph writes; per-suite table names isolate DynamoDB.
const globalSetup = [
  fileURLToPath(new URL('./test/gremlin-setup.js', import.meta.url)),
  fileURLToPath(new URL('./test/dynamodb-setup.js', import.meta.url)),
];

// These projects contain integration tests that connect to the shared local
// Gremlin or DynamoDB services. Mutation runs for all other projects stay unit-only.
const infrastructureLambdas = new Set([
  'agentcore',
  'agents',
  'discussions',
  'intents',
  'migrate-tracker-fields',
  'projects',
  'purge-neptune',
  'questions',
  'sprint-graph',
  'sprints',
  'tasks',
  'timeline-events',
  'trackers',
]);

export const backendProjects = lambdas.map((name) => ({
  name,
  requiresInfrastructure: infrastructureLambdas.has(name),
  config: {
    test: {
      name,
      root: fileURLToPath(new URL(name, lambdaRoot)),
      include: ['test/**/*.test.js'],
      setupFiles,
    },
  },
}));

export { globalSetup as backendGlobalSetup };

export default defineConfig({
  test: {
    projects: backendProjects.map((project) => project.config),
    globalSetup,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json-summary', 'json'],
      reportsDirectory: './coverage',
      include: ['lambda/**/*.js'],
      exclude: ['lambda/**/test/**', 'lambda/**/*.config.js', 'lambda/**/node_modules/**'],
      all: true,
    },
  },
});
