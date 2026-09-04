import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import rootPackage from '../package.json' with { type: 'json' };

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    target: 'es2022',
  },
  define: {
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(rootPackage.version),
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, './src'),
    },
  },
});
