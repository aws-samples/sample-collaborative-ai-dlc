import tsParser from '@typescript-eslint/parser';
import sonarjs from 'eslint-plugin-sonarjs';

// A focused, advisory analysis. Oxlint remains the repository's normal linter.
export default [
  {
    ignores: [
      '**/node_modules/**',
      '**/.build/**',
      '**/dist/**',
      '**/coverage/**',
      '**/.stryker-tmp/**',
      '**/test/**',
      '**/tests/**',
      '**/__tests__/**',
      '**/__mocks__/**',
      '**/fixtures/**',
      '**/*.{test,spec}.*',
      '**/*.d.ts',
    ],
  },
  {
    files: ['lambda/**/*.{js,mjs,cjs}', 'frontend/src/**/*.{js,jsx,ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    plugins: { sonarjs },
    rules: {
      'sonarjs/cognitive-complexity': ['warn', 15],
    },
  },
];
