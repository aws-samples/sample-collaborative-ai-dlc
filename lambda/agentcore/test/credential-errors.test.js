import { describe, it, expect } from 'vitest';
import { isCreditExhaustion } from '../cli/credential-errors.js';

describe('provider credit exhaustion', () => {
  it.each([
    'Insufficient credits to complete this request',
    'You are out of credits',
    'Credits have been exhausted',
    'Monthly usage limit exceeded',
    '403: credit limit reached',
    '{"error":{"code":"insufficient_quota"}}',
  ])('recognizes an exhausted allowance: %s', (text) => {
    expect(isCreditExhaustion(text)).toBe(true);
  });
  it.each(['429 Too Many Requests', 'rate limit exceeded', 'invalid API key', 'Credits: 0.42', ''])(
    'does not confuse throttling, authentication or spend with exhausted credits: %s',
    (text) => expect(isCreditExhaustion(text)).toBe(false),
  );
});
