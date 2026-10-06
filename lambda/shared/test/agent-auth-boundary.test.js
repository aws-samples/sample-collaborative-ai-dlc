// Foundation modules stay provider-neutral: a provider plugs in through its deployable's
// composition root, never through a literal here. The list is fixed so provider changes never
// edit it. Deliberately absent: the composition roots, agent-auth-builtin-modes.js (the planned
// descriptors a provider replaces), agent-auth-protocol.js (the mechanism vocabulary, which
// names 'assume-role') and agent-oauth-contract.js (mechanism authorization rules).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const LAMBDA = new URL('../../', import.meta.url);
const FOUNDATION_FILES = Object.freeze([
  'shared/agent-auth-providers.js',
  'shared/agent-auth-mode-registry.js',
  'shared/agent-auth-contracts.js',
  'shared/agent-auth-selection-strategies.js',
  'shared/agent-binding-selection.js',
  'shared/agent-auth-actions.js',
  'shared/agent-connection-repository.js',
  'shared/agent-auth-inventory-repository.js',
  'shared/agent-auth-review-repository.js',
  'shared/agent-auth-changes.js',
  'shared/agent-auth-runtime-capabilities.js',
  'shared/agent-command-registry.js',
  'shared/agent-credential-grants.js',
  'shared/agent-credential-service.js',
  'shared/agent-credential-lease.js',
  'shared/agent-auth-redemption.js',
  'credential-broker/agent-provider-registry.js',
  'credential-broker/agent-authentication.js',
  'credential-broker/agent-credential-renewal.js',
  'credential-broker/key-broker-provider.js',
  'credential-broker/index.js',
  'agentcore/credential-material-registry.js',
  'agentcore/keys-runtime-provider.js',
  'agentcore/authentication-command-registry.js',
  'agentcore/auth-resolver.js',
  'agentcore/credential-lease-adapters.js',
  'agentcore/credential-session.js',
  'agentcore/http-server.js',
  'agentcore/commands/capabilities.js',
  'agentcore/commands/verify-connection.js',
  'agentcore/mcp-secret-resolver.js',
  'agents/authentication-settings-service.js',
  'agents/authentication-connection-verification.js',
  'agents/index.js',
]);
const PROVIDER_LITERAL =
  /['"]iam['"]|\biam\s*:|assume-role|bedrock-iam|verify-bedrock-iam|BEDROCK_AUTH_MODE|roleArn|canManageIam|renew-bedrock-credentials|RENEW_BEDROCK_CREDENTIALS|iam-connection/;

const providerLiterals = (file, source) =>
  source
    .split('\n')
    .flatMap((text, index) =>
      PROVIDER_LITERAL.test(text) ? [`${file}:${index + 1}: ${text.trim()}`] : [],
    );

describe('foundation provider boundary', () => {
  it.each(FOUNDATION_FILES)('lambda/%s names no authentication provider', (file) => {
    const source = readFileSync(new URL(file, LAMBDA), 'utf8');
    expect(providerLiterals(`lambda/${file}`, source)).toEqual([]);
  });

  it('reports each provider branch by file and line', () => {
    const source = [
      '// Only a credential adapter introduces inference IAM credentials.',
      "if (policy.mode === 'iam') return selectIamBinding(policy);",
      'const strategies = { keys: selectKeysBinding, iam: selectIamBinding };',
      "mechanism: 'api-key',",
      'delete env.BEDROCK_AUTH_MODE;',
      "import { RENEWAL } from './bedrock-iam-provider.js';",
      'const claims = { ...grant.claims, roleArn };',
      "const RENEW_BEDROCK_CREDENTIALS = 'renew-bedrock-credentials';",
    ].join('\n');
    expect(providerLiterals('sample.js', source)).toEqual([
      "sample.js:2: if (policy.mode === 'iam') return selectIamBinding(policy);",
      'sample.js:3: const strategies = { keys: selectKeysBinding, iam: selectIamBinding };',
      'sample.js:5: delete env.BEDROCK_AUTH_MODE;',
      "sample.js:6: import { RENEWAL } from './bedrock-iam-provider.js';",
      'sample.js:7: const claims = { ...grant.claims, roleArn };',
      "sample.js:8: const RENEW_BEDROCK_CREDENTIALS = 'renew-bedrock-credentials';",
    ]);
  });
});
