import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: fileURLToPath(new URL('.', import.meta.url)),
    include: ['test/**/*.test.js'],
    setupFiles: [fileURLToPath(new URL('../../test/setup.js', import.meta.url))],
  },
});
