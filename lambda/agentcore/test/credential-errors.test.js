import { describe, it, expect } from 'vitest';
import { isCreditExhaustion } from '../cli/credential-errors.js';
import { readFileSync } from 'node:fs';

const providerMessages = JSON.parse(
  readFileSync(new URL('./fixtures/provider-quota-messages.json', import.meta.url), 'utf8'),
);

describe('provider credit exhaustion', () => {
  it.each([
    'Insufficient credits to complete this request',
    'You are out of credits',
    'Credits have been exhausted',
    'Monthly usage limit exceeded',
    '403: credit limit reached',
    '{"error":{"code":"insufficient_quota"}}',
    'Your credit balance is too low to access the Anthropic API',
    'You exceeded your current quota usage limit reached',
    'Usage limit reached',
    'Quota usage limit exceeded',
    '{"error":{"code":"billing_hard_limit_reached"}}',
  ])('recognizes an exhausted allowance: %s', (text) => {
    expect(isCreditExhaustion(text)).toBe(true);
  });
  it.each(['429 Too Many Requests', 'rate limit exceeded', 'invalid API key', 'Credits: 0.42', ''])(
    'does not confuse throttling, authentication or spend with exhausted credits: %s',
    (text) => expect(isCreditExhaustion(text)).toBe(false),
  );
  it.each(providerMessages)(
    'classifies a reported $cli message from $source',
    ({ output, exhausted }) => {
      expect(isCreditExhaustion(output)).toBe(exhausted);
    },
  );
});
