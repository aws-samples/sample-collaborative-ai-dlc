import { defineConfig } from 'vitest/config';
import react from '@vitejs/plugin-react';
import path from 'path';

// Frontend unit/component test runner. Separate from the backend root
// vitest.config.js (which spins up gremlin + dynamodb containers); this one runs
// hermetically under jsdom with no external services. The `@/` alias mirrors
// vite.config.ts so imports resolve the same way in tests.
export default defineConfig({
  plugins: [react()],
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify('2.0.0-test'),
    'import.meta.env.VITE_ENVIRONMENT': JSON.stringify('test'),
  },
  resolve: {
    alias: { '@': path.resolve(import.meta.dirname, './src') },
  },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    css: false,
  },
});
