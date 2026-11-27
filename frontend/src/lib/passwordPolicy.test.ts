import { describe, expect, it } from 'vitest';
import { passwordPolicyError } from './passwordPolicy';
import passwordCases from './passwordPolicyCases.json';

describe('passwordPolicyError', () => {
  it('accepts a password that meets the user pool policy', () => {
    expect(passwordPolicyError('Correct-horse-9')).toBeNull();
    // An inner space counts as a Cognito special character.
    expect(passwordPolicyError('Correct horse 9')).toBeNull();
  });

  it.each([
    ['Sh0rt-pass', 'at least 12 characters'],
    ['NO-LOWERCASE-123', 'lowercase'],
    ['no-uppercase-123', 'uppercase'],
    ['No-digits-here!', 'number'],
    ['NoSymbolsHere123', 'symbol'],
    ['Password1234€', 'symbol'],
    [' Password-1234', 'start or end with a space'],
    ['Password-1234 ', 'start or end with a space'],
  ])('rejects %s', (password, reason) => {
    expect(passwordPolicyError(password)).toContain(reason);
  });

  // The installer runs the same cases (scripts/test/release-tools.test.mjs).
  it.each(passwordCases)('matches the shared case: $case', ({ password, valid }) => {
    expect(passwordPolicyError(password) === null).toBe(valid);
  });
});
