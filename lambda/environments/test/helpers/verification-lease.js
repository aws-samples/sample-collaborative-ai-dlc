import { vi } from 'vitest';

// In-memory stand-in for the store's verification lease, with the same rules
// as the DynamoDB conditional write in store.js: only a VERIFYING revision can
// be leased, and only when no unexpired lease is held. The real write is
// covered against DynamoDB Local in verification-lease.test.js.
export const withVerificationLease = (store) => {
  let lease = null;
  store.acquireVerificationLease = vi.fn(async (environmentId, revisionId, { owner, ttlMs }) => {
    const current = await store.getRevision(environmentId, revisionId);
    if (current?.status !== 'VERIFYING') return null;
    if (lease && lease.expiresAt > Date.now()) return null;
    lease = { owner, expiresAt: Date.now() + ttlMs };
    return current;
  });
  store.releaseVerificationLease = vi.fn(async (_environmentId, _revisionId, owner) => {
    if (lease?.owner === owner) lease = null;
  });
  return store;
};
