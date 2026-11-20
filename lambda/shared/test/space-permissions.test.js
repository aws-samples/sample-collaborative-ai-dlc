import { readFileSync } from 'node:fs';
import { validate } from '@cedar-policy/cedar-wasm/nodejs';
import * as cedar from '@cedar-policy/cedar-wasm/nodejs';
import { describe, expect, it, vi } from 'vitest';
import {
  SPACE_POLICY_URL,
  spacePermissions,
  fetchSpacePermissions,
  createCedarPolicyEvaluator,
} from '../space-permissions.js';
import { membershipStore } from '../space-membership.js';
import { realtimePermissions } from '../realtime-permissions.js';

vi.mock('@cedar-policy/cedar-wasm/nodejs', async (original) => {
  const actual = await original();
  return { ...actual, preparsePolicySet: vi.fn(actual.preparsePolicySet) };
});

describe('prepared Cedar evaluation', () => {
  const request = (userId) => ({
    principal: { type: 'User', id: userId },
    action: { type: 'Action', id: 'decide' },
    resource: { type: 'Stage', id: 'requirements-analysis' },
    context: {},
    entities: [],
  });

  it('parses a policy once for many members and still evaluates each identity', () => {
    const parse = vi.spyOn(cedar, 'preparsePolicySet');
    const policies = 'permit(principal == User::"cache-test-one", action, resource);';
    try {
      const evaluate = createCedarPolicyEvaluator(policies);
      for (let i = 0; i < 100; i++) expect(evaluate(request(`other-${i}`))).toBe(false);
      expect(evaluate(request('cache-test-one'))).toBe(true);
      expect(createCedarPolicyEvaluator(policies)(request('other'))).toBe(false);
      expect(parse).toHaveBeenCalledTimes(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('reuses one bounded slot across workflow changes without using another policy or stale allows', () => {
    const parse = vi.spyOn(cedar, 'preparsePolicySet');
    try {
      const first = createCedarPolicyEvaluator(
        'permit(principal == User::"first", action, resource);',
      );
      const second = createCedarPolicyEvaluator(
        'permit(principal == User::"second", action, resource);',
      );
      expect(first(request('first'))).toBe(true);
      expect(first(request('second'))).toBe(false);
      expect(second(request('first'))).toBe(false);
      expect(second(request('second'))).toBe(true);
      expect(() => createCedarPolicyEvaluator('broken Cedar')).toThrow(
        'Cedar policy parsing failed',
      );
      expect(() => createCedarPolicyEvaluator(undefined)).toThrow('Cedar policy parsing failed');
      expect(() => createCedarPolicyEvaluator('')).toThrow('Cedar policy parsing failed');
      expect(first(request('first'))).toBe(true);
      expect(first(request('second'))).toBe(false);
      expect(new Set(parse.mock.calls.map(([id]) => id)).size).toBe(1);
    } finally {
      parse.mockRestore();
    }
  });

  it('propagates authorization diagnostics instead of returning eligible people', () => {
    const evaluate = createCedarPolicyEvaluator(
      'permit(principal, action, resource) when { principal.missing };',
    );
    expect(() => evaluate(request('member'))).toThrow('Cedar permission evaluation failed');
  });
});

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
