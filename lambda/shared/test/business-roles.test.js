import { describe, expect, it } from 'vitest';
import {
  combineMemberRoles,
  computeSsoBusinessRoles,
  normalizeExcludedRoles,
  normalizeRoleMappings,
} from '../business-roles.js';

describe('business-role calculation', () => {
  it('grants a role when any mapped value matches and combines values across roles', () => {
    const roleMappings = {
      developer: ['Engineering', 'Contractors'],
      architect: ['Engineering'],
      'qa-tester': ['Quality'],
    };
    // Matching is exact, including case; one value may grant several roles.
    expect(computeSsoBusinessRoles(['Engineering'], roleMappings)).toEqual([
      'architect',
      'developer',
    ]);
    expect(computeSsoBusinessRoles(['Contractors', 'Quality'], roleMappings)).toEqual([
      'developer',
      'qa-tester',
    ]);
    expect(computeSsoBusinessRoles(['engineering'], roleMappings)).toEqual([]);
    expect(computeSsoBusinessRoles([], roleMappings)).toEqual([]);
    expect(computeSsoBusinessRoles(['Engineering'], {})).toEqual([]);
    expect(computeSsoBusinessRoles(['Engineering'], undefined)).toEqual([]);
  });

  it('computes space roles as (SSO − excluded) + local, keeping excluded roles locally assignable', () => {
    // The Alice example: same SSO roles, different exclusions per space.
    const alice = { ssoRoles: ['architect', 'developer'] };
    expect(combineMemberRoles({ ...alice, excludedRoles: ['developer'] })).toEqual(['architect']);
    expect(combineMemberRoles({ ...alice, excludedRoles: ['architect'] })).toEqual(['developer']);
    // A local assignment stays active even when the same role is excluded from SSO.
    expect(
      combineMemberRoles({ ...alice, excludedRoles: ['developer'], localRoles: ['developer'] }),
    ).toEqual(['architect', 'developer']);
    expect(combineMemberRoles({})).toEqual([]);
    expect(combineMemberRoles({ localRoles: ['qa-tester'] })).toEqual(['qa-tester']);
  });

  it('validates excluded role lists and mapping shapes', () => {
    expect(normalizeExcludedRoles(['developer', 'developer', 'architect'])).toEqual([
      'architect',
      'developer',
    ]);
    expect(() => normalizeExcludedRoles(['made-up'])).toThrowError(/excludedRoles/);
    expect(normalizeRoleMappings({ developer: ['B', 'A', ' B '] })).toEqual({
      developer: ['A', 'B'],
    });
    expect(normalizeRoleMappings({ developer: [] })).toEqual({});
    for (const invalid of [
      { 'made-up': ['x'] },
      { developer: [''] },
      { developer: [1] },
      { developer: 'x' },
      [],
      null,
    ]) {
      expect(() => normalizeRoleMappings(invalid)).toThrowError();
    }
  });
});
