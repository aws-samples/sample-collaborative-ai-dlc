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

export default defineConfig({
  test: {
    projects: lambdas.map((name) => ({
      test: {
        name,
        root: fileURLToPath(new URL(name, lambdaRoot)),
        include: ['test/**/*.test.js'],
        setupFiles,
      },
    })),
    globalSetup,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      reportsDirectory: './coverage',
      include: ['lambda/**/*.js'],
      exclude: ['lambda/**/test/**', 'lambda/**/*.config.js', 'lambda/**/node_modules/**'],
      all: true,
    },
  },
});
