import { describe, it, expect } from 'vitest';
import { isCredentialFailure, isExpiredCredentialFailure } from '../cli/credential-errors.js';

// specs/bedrock-iam-role-credential-mode — req-expiry-failure-legible. An expired
// temporary credential must be distinguishable from a rejected or rotated one:
// the binding is fine and a retry resolves a fresh credential, whereas a rejected
// credential needs an operator to rotate it.
describe('isExpiredCredentialFailure', () => {
  it.each([
    'ExpiredToken: The security token included in the request is expired',
    'ExpiredTokenException',
    'The security token included in the request is expired',
    'The provided token has expired.',
    'error: credentials have expired',
    'Error: session token expired',
    'botocore.exceptions.ClientError: expired security token',
  ])('recognizes %s', (stderr) => {
    expect(isExpiredCredentialFailure(stderr)).toBe(true);
  });

  it.each([
    '',
    'HTTP 500 internal server error',
    'ValidationException: The provided model identifier is invalid',
    'Error: ENOENT no such file or directory',
    'AccessDeniedException: not authorized to perform bedrock:InvokeModel',
  ])('does not fire on %s', (stderr) => {
    expect(isExpiredCredentialFailure(stderr)).toBe(false);
  });

  it('is checked before the generic classifier, whose pattern also matches expiry', () => {
    // Both fire on this, which is exactly why order matters at the call site.
    const overlapping = 'Error: credential expired';
    expect(isExpiredCredentialFailure(overlapping)).toBe(true);
    expect(isCredentialFailure(overlapping)).toBe(true);
    // The STS wording is recognized ONLY by the expiry classifier, so without it
    // an expiry would have fallen through to cli_nonzero_exit.
    const stsWording =
      'ExpiredTokenException: The security token included in the request is expired';
    expect(isExpiredCredentialFailure(stsWording)).toBe(true);
    expect(isCredentialFailure(stsWording)).toBe(false);
    // A rejected credential is NOT an expiry, so it keeps the existing reason.
    const rejected = 'HTTP 403 Forbidden: invalid api-key';
    expect(isExpiredCredentialFailure(rejected)).toBe(false);
    expect(isCredentialFailure(rejected)).toBe(true);
  });

  it('tolerates a non-string tail', () => {
    expect(isExpiredCredentialFailure(undefined)).toBe(false);
    expect(isExpiredCredentialFailure(null)).toBe(false);
  });
});
