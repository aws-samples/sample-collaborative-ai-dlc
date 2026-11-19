import { expect, vi, afterAll } from 'vitest';
import * as matchers from 'aws-sdk-client-mock-vitest';

expect.extend(matchers);

vi.mock('../lambda/shared/space-membership.js', async (importOriginal) => {
  const actual = await importOriginal();
  const { createTestMembershipStore } = await import('./membership-store.js');
  const fixture = await createTestMembershipStore(actual.createMembershipStore);
  afterAll(fixture.cleanup);
  return {
    ...actual,
    membershipStore: fixture.store,
    fetchMembershipRole: (g, spaceId, userId, store = fixture.store) =>
      actual.fetchMembershipRole(g, spaceId, userId, store),
  };
});
