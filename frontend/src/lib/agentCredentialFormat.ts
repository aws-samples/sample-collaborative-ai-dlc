// Advisory format hints for the write-only agent credential fields.
//
// A key pasted into the other provider's field saves without complaint and only
// fails once an agent stage runs: Kiro CLI prints "Access denied: The bearer token
// included in the request is invalid." and the stage ends without doing any work.
// These hints catch that mix-up while the value is still in the form.
//
// They warn and never block a save. Kiro documents its API key format by example
// (`ksk_…`, https://kiro.dev/docs/getting-started/authentication/), not as a
// contract, so a stricter check could reject a valid key.

export type AgentCredentialField = 'bedrockBearerToken' | 'kiroApiKey';

export const KIRO_API_KEY_PREFIX = 'ksk_';

export function agentCredentialFormatWarning(
  field: AgentCredentialField,
  value: string,
): string | null {
  const trimmed = value.trim();
  if (trimmed === '') return null;
  const looksLikeKiroKey = trimmed.startsWith(KIRO_API_KEY_PREFIX);
  // No warning while someone is still typing the prefix itself ("k", "ks", "ksk").
  const typingPrefix = KIRO_API_KEY_PREFIX.startsWith(trimmed);
  if (field === 'kiroApiKey' && !looksLikeKiroKey && !typingPrefix) {
    return `This does not look like a Kiro API key, which starts with "${KIRO_API_KEY_PREFIX}" (create one in the Kiro portal). An Amazon Bedrock API key goes in Bedrock Bearer Token.`;
  }
  if (field === 'bedrockBearerToken' && looksLikeKiroKey) {
    return `This looks like a Kiro API key ("${KIRO_API_KEY_PREFIX}…"). It goes in Kiro API Key; this field takes an Amazon Bedrock API key.`;
  }
  return null;
}
