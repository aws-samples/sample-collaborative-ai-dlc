import { describe, expect, it, vi } from 'vitest';
import { verifySnapshots } from '../verify-snapshots.js';

describe('independent snapshot verification', () => {
  it.each([undefined, {}, { snapshotKey: 'unversioned.bin' }])(
    'refuses to certify a document without a committed immutable version: %j',
    async (manifest) => {
      const store = { get: vi.fn().mockResolvedValue(manifest), load: vi.fn() };
      const result = await verifySnapshots(store, {
        run: 'test',
        expectedRooms: [{ documentId: 'test-document' }],
      });
      expect(result.verified).toBe(false);
      expect(result.checks[0].reason).toBe('No committed checkpoint version');
      expect(store.load).not.toHaveBeenCalled();
    },
  );
});
