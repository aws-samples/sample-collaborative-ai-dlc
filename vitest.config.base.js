import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['test/**/*.test.js'],
    setupFiles: [fileURLToPath(new URL('./test/setup.js', import.meta.url))],
  },
});
