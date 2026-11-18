import { describe, expect, it } from 'vitest';
import { passwordPolicyError } from './passwordPolicy';

describe('passwordPolicyError', () => {
  it('accepts a password that meets the user pool policy', () => {
    expect(passwordPolicyError('Correct-horse-9')).toBeNull();
  });

  it.each([
    ['Sh0rt-pass', 'at least 12 characters'],
    ['NO-LOWERCASE-123', 'lowercase'],
    ['no-uppercase-123', 'uppercase'],
    ['No-digits-here!', 'number'],
    ['NoSymbolsHere123', 'symbol'],
  ])('rejects %s', (password, reason) => {
    expect(passwordPolicyError(password)).toContain(reason);
  });
});
