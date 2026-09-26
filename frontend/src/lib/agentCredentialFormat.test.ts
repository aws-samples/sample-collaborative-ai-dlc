import { describe, expect, it } from 'vitest';
import { agentCredentialFormatWarning } from './agentCredentialFormat';

describe('agentCredentialFormatWarning', () => {
  it('stays quiet while a field is empty', () => {
    expect(agentCredentialFormatWarning('kiroApiKey', '')).toBeNull();
    expect(agentCredentialFormatWarning('kiroApiKey', '   ')).toBeNull();
    expect(agentCredentialFormatWarning('bedrockBearerToken', '')).toBeNull();
  });

  it('accepts a Kiro API key in the Kiro field, surrounding whitespace included', () => {
    expect(agentCredentialFormatWarning('kiroApiKey', 'ksk_example')).toBeNull();
    expect(agentCredentialFormatWarning('kiroApiKey', '  ksk_example\n')).toBeNull();
  });

  it('stays quiet while the "ksk_" prefix is still being typed', () => {
    expect(agentCredentialFormatWarning('kiroApiKey', 'k')).toBeNull();
    expect(agentCredentialFormatWarning('kiroApiKey', 'ksk')).toBeNull();
    expect(agentCredentialFormatWarning('kiroApiKey', 'kx')).toMatch(/starts with "ksk_"/);
  });

  it('warns when the Kiro field holds something else, such as a Bedrock API key', () => {
    expect(agentCredentialFormatWarning('kiroApiKey', 'bedrock-api-key-example')).toMatch(
      /starts with "ksk_"/,
    );
  });

  it('warns when a Kiro API key is entered in the Bedrock field', () => {
    expect(agentCredentialFormatWarning('bedrockBearerToken', 'ksk_example')).toMatch(
      /It goes in Kiro API Key/,
    );
  });

  it('does not judge other values in the Bedrock field', () => {
    expect(
      agentCredentialFormatWarning('bedrockBearerToken', 'bedrock-api-key-example'),
    ).toBeNull();
  });
});
