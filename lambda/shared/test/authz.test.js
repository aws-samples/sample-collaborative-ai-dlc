import { describe, it, expect } from 'vitest';

import {
  PLATFORM_ADMIN_GROUP,
  parseGroups,
  getGroups,
  isPlatformAdmin,
  requirePlatformAdmin,
} from '../authz.js';

const eventWithGroups = (groups) => ({
  requestContext: {
    authorizer: { claims: { sub: 'user-1', 'cognito:groups': groups } },
  },
});

describe('parseGroups', () => {
  it('returns [] for missing/empty values', () => {
    expect(parseGroups(undefined)).toEqual([]);
    expect(parseGroups(null)).toEqual([]);
    expect(parseGroups('')).toEqual([]);
    expect(parseGroups('   ')).toEqual([]);
    expect(parseGroups(42)).toEqual([]);
  });

  it('accepts a real array', () => {
    expect(parseGroups(['platform-admin', 'member'])).toEqual(['platform-admin', 'member']);
  });

  it('accepts a JSON array string', () => {
    expect(parseGroups('["platform-admin","member"]')).toEqual(['platform-admin', 'member']);
  });

  it("accepts API Gateway's bracket form (space separated)", () => {
    expect(parseGroups('[platform-admin member]')).toEqual(['platform-admin', 'member']);
  });

  it('accepts a single bracketed group', () => {
    expect(parseGroups('[platform-admin]')).toEqual(['platform-admin']);
  });

  it('accepts a comma-joined string', () => {
    expect(parseGroups('platform-admin,member')).toEqual(['platform-admin', 'member']);
  });

  it('accepts a bare single group', () => {
    expect(parseGroups('platform-admin')).toEqual(['platform-admin']);
  });
});

describe('getGroups / isPlatformAdmin', () => {
  it('reads groups from the authorizer claims', () => {
    expect(getGroups(eventWithGroups('platform-admin,owner'))).toEqual(['platform-admin', 'owner']);
  });

  it('returns [] when the event has no claims', () => {
    expect(getGroups({})).toEqual([]);
    expect(getGroups({ requestContext: {} })).toEqual([]);
  });

  it('detects platform admins across claim shapes', () => {
    expect(isPlatformAdmin(eventWithGroups(PLATFORM_ADMIN_GROUP))).toBe(true);
    expect(isPlatformAdmin(eventWithGroups('[platform-admin owner]'))).toBe(true);
    expect(isPlatformAdmin(eventWithGroups(['platform-admin']))).toBe(true);
  });

  it('fails closed for non-admins and partial matches', () => {
    expect(isPlatformAdmin(eventWithGroups('member'))).toBe(false);
    expect(isPlatformAdmin(eventWithGroups('platform-administrator'))).toBe(false);
    expect(isPlatformAdmin({})).toBe(false);
  });
});

describe('requirePlatformAdmin', () => {
  it('returns null for platform admins', () => {
    expect(requirePlatformAdmin(eventWithGroups('platform-admin'))).toBeNull();
  });

  it('returns a 403 descriptor for everyone else', () => {
    const denied = requirePlatformAdmin(eventWithGroups('member'));
    expect(denied).toEqual({
      statusCode: 403,
      error: 'Platform administrator access required',
      code: 'PLATFORM_ADMIN_REQUIRED',
    });
  });
});
