import { readFileSync } from 'node:fs';
import path from 'node:path';

// The settings shells and their contracts stay provider-neutral: a provider UI registers
// in registry.ts (the composition root, deliberately not scanned) and keeps its own copy
// and types in its folder. The list is fixed so provider changes never edit it.
const SRC = path.resolve(import.meta.dirname, '../../..');
const SHELL_FILES = [
  'components/settings/AgentAuthenticationModeSettings.tsx',
  'components/settings/AgentCredentialScopeCard.tsx',
  'components/settings/AuthenticationImpactReview.tsx',
  'components/settings/agent-auth/contract.ts',
  'components/settings/agent-auth/summary.ts',
  'services/agents.ts',
] as const;
const PROVIDER_LITERAL =
  /['"]iam['"]|\biam\s*:|assume-role|bedrock-iam|verify-bedrock-iam|BEDROCK_AUTH_MODE|roleArn|canManageIam|renew-bedrock-credentials|RENEW_BEDROCK_CREDENTIALS|iam-connection|BedrockIam|IAM role|legacy-platform-bedrock|\bIAM\b|\biam[A-Z]/;

const providerLiterals = (file: string, source: string) =>
  source
    .split('\n')
    .flatMap((text, index) =>
      PROVIDER_LITERAL.test(text) ? [`${file}:${index + 1}: ${text.trim()}`] : [],
    );

describe('settings provider boundary', () => {
  it.each(SHELL_FILES)('src/%s names no authentication provider', (file) => {
    const source = readFileSync(path.join(SRC, file), 'utf8');
    expect(providerLiterals(`src/${file}`, source)).toEqual([]);
  });

  it('reports each provider branch by file and line', () => {
    const source = [
      "const noun = ui?.noun ?? 'connection';",
      "import { BedrockIamWizard } from './BedrockIamWizard';",
      "if (mode === 'keys') switchTo('legacy-platform-bedrock');",
      '<span>Proposed IAM role</span>',
      "| { kind: 'iam-connection'; configuration: Record<string, unknown> }",
      '<p>Agents authenticate with IAM.</p>',
      'const iamActive = policyMode === selected;',
      'const diameter = liamOffset + 1;',
    ].join('\n');
    expect(providerLiterals('Sample.tsx', source)).toEqual([
      "Sample.tsx:2: import { BedrockIamWizard } from './BedrockIamWizard';",
      "Sample.tsx:3: if (mode === 'keys') switchTo('legacy-platform-bedrock');",
      'Sample.tsx:4: <span>Proposed IAM role</span>',
      "Sample.tsx:5: | { kind: 'iam-connection'; configuration: Record<string, unknown> }",
      'Sample.tsx:6: <p>Agents authenticate with IAM.</p>',
      'Sample.tsx:7: const iamActive = policyMode === selected;',
    ]);
  });
});
