import { readFileSync } from 'node:fs';
import { validate } from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, it, vi } from 'vitest';
import { SPACE_POLICY_URL, spacePermissions, fetchSpacePermissions } from '../space-permissions.js';
import { membershipStore } from '../space-membership.js';
import { realtimePermissions } from '../realtime-permissions.js';

describe('Cedar space permissions', () => {
  it('validates the shipped policy against its schema', () => {
    // A misspelled attribute or action would otherwise evaluate silently to deny.
    const answer = validate({
      schema: readFileSync(new URL('./space.cedarschema', SPACE_POLICY_URL), 'utf8'),
      policies: { staticPolicies: readFileSync(SPACE_POLICY_URL, 'utf8') },
    });
    expect(answer).toMatchObject({
      type: 'success',
      validationErrors: [],
      validationWarnings: [],
    });
  });

  it.each([
    ['owner', { read: true, write: true, manage: true }],
    ['member', { read: true, write: true, manage: false }],
    ['viewer', { read: true, write: false, manage: false }],
    [null, { read: false, write: false, manage: false }],
    ['platform-admin', { read: false, write: false, manage: false }],
    ['developer', { read: false, write: false, manage: false }],
  ])('evaluates %s through Cedar', (role, expected) => {
    expect(spacePermissions(role)).toEqual(expected);
  });

  it('reads current membership again and never promotes business roles into access', async () => {
    const g = { V: () => ({ has: () => ({ hasNext: async () => true }) }) };
    const get = vi
      .spyOn(membershipStore, 'get')
      .mockResolvedValueOnce({ membershipRole: 'member' })
      .mockResolvedValueOnce({
        membershipRole: 'viewer',
        localRoles: ['developer'],
        companyRoles: ['architect'],
      })
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new Error('Unavailable'));
    try {
      expect((await fetchSpacePermissions(g, 's', 'u')).permissions.write).toBe(true);
      expect((await fetchSpacePermissions(g, 's', 'u')).permissions).toEqual({
        read: true,
        write: false,
        manage: false,
      });
      expect((await fetchSpacePermissions(g, 's', 'u')).permissions.read).toBe(false);
      await expect(fetchSpacePermissions(g, 's', 'u')).rejects.toThrow('Unavailable');
      expect(get).toHaveBeenCalledTimes(4);
    } finally {
      get.mockRestore();
    }
  });

  it('denies a dangling membership and missing intent', async () => {
    const g = { V: () => ({ has: () => ({ hasNext: async () => false }) }) };
    expect((await fetchSpacePermissions(g, 'deleted', 'u')).permissions.read).toBe(false);
    const store = { getExecution: vi.fn().mockResolvedValue({ projectId: 'actual' }) };
    expect(
      await realtimePermissions(g, store, { sub: 'u', scope: 'intent:i', projectId: 'other' }),
    ).toEqual({ read: false, write: false, manage: false });
    expect(store.getExecution).toHaveBeenCalledWith('i', { consistentRead: true });
  });
});

it('resolves an intent space from authoritative state without requiring a token project scope', async () => {
  const g = { V: () => ({ has: () => ({ hasNext: async () => true }) }) };
  const store = { getExecution: vi.fn().mockResolvedValue({ projectId: 'actual' }) };
  const get = vi.spyOn(membershipStore, 'get').mockResolvedValue({ membershipRole: 'member' });
  try {
    expect(await realtimePermissions(g, store, { sub: 'u', scope: 'intent:i' })).toEqual({
      read: true,
      write: true,
      manage: false,
      spaceId: 'actual',
    });
    expect(get).toHaveBeenCalledWith('actual', 'u');
    expect(store.getExecution).toHaveBeenCalledWith('i', { consistentRead: true });
    store.getExecution.mockResolvedValue(null);
    expect(await realtimePermissions(g, store, { sub: 'u', scope: 'intent:gone' })).toEqual({
      read: false,
      write: false,
      manage: false,
    });
  } finally {
    get.mockRestore();
  }
});
