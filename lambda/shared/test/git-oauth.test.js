import { describe, it, expect } from 'vitest';
import {
  createSignedState,
  verifySignedState,
  validateParamName,
  GIT_TOKEN_PARAM_PATTERN,
  getUserId,
} from '../git-oauth.js';

describe('createSignedState / verifySignedState', () => {
  const secret = 'test-secret-key';

  it('round-trips a payload through sign/verify', () => {
    const payload = { userId: 'user-123', ts: 1700000000000 };
    const state = createSignedState(payload, secret);
    const result = verifySignedState(state, secret);
    expect(result).toEqual(payload);
  });

  it('returns null for a tampered state', () => {
    const state = createSignedState({ userId: 'user-1' }, secret);
    // Flip a character in the signature portion
    const tampered = state.slice(0, -1) + (state.at(-1) === '0' ? '1' : '0');
    expect(verifySignedState(tampered, secret)).toBeNull();
  });

  it('returns null for a malformed state (no dot)', () => {
    expect(verifySignedState('nodot', secret)).toBeNull();
  });

  it('returns null when verified with the wrong secret', () => {
    const state = createSignedState({ userId: 'u' }, secret);
    expect(verifySignedState(state, 'wrong-secret')).toBeNull();
  });
});

describe('validateParamName', () => {
  it('accepts valid SSM parameter names', () => {
    expect(() => validateParamName('/project/env/git-token/user-123')).not.toThrow();
  });

  it('rejects invalid SSM parameter names', () => {
    expect(() => validateParamName('invalid')).toThrow('Invalid SSM parameter name format');
    expect(() => validateParamName('/only/two')).toThrow();
    expect(() => validateParamName('')).toThrow();
  });
});

describe('GIT_TOKEN_PARAM_PATTERN', () => {
  it('matches expected format', () => {
    expect(GIT_TOKEN_PARAM_PATTERN.test('/a/b/c/d')).toBe(true);
    expect(GIT_TOKEN_PARAM_PATTERN.test('/project-name/dev/git-token/user-id')).toBe(true);
  });

  it('rejects too-short paths', () => {
    expect(GIT_TOKEN_PARAM_PATTERN.test('/a/b/c')).toBe(false);
  });
});

describe('getUserId', () => {
  it('extracts sub from Cognito authorizer claims', () => {
    const event = { requestContext: { authorizer: { claims: { sub: 'user-abc' } } } };
    expect(getUserId(event)).toBe('user-abc');
  });

  it('returns undefined when claims are missing', () => {
    expect(getUserId({})).toBeUndefined();
    expect(getUserId({ requestContext: {} })).toBeUndefined();
  });
});
