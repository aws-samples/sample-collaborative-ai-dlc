import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { readdirSync, existsSync } from 'node:fs';

const lambdaRoot = new URL('./lambda/', import.meta.url);
const lambdas = readdirSync(fileURLToPath(lambdaRoot)).filter((name) =>
  existsSync(new URL(`${name}/test`, lambdaRoot)),
);

const setupFiles = [fileURLToPath(new URL('./test/setup.js', import.meta.url))];

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
