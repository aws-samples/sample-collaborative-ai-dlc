import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'lambda/shared/test/space-membership.test.js',
      'lambda/migrate-space-memberships/test/migrate-space-memberships.test.js',
    ],
  },
});
