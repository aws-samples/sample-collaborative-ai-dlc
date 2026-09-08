import type { AgentCredentialSource, BedrockCredentialMode } from '@/services/agents';
import type { AgentCli } from '@/services/projects';

export type AgentCredentialProvider = 'bedrock' | 'kiro';

interface AgentCliMetadata {
  label: string;
  modelLabel: string;
  description: string;
  credentialProvider: AgentCredentialProvider;
  modelHelp: {
    label: string;
    url: string;
  };
  modelPlaceholder: string;
}

export const AGENT_CLIS = [
  'kiro',
  'claude',
  'opencode',
  'codex',
] as const satisfies readonly AgentCli[];

export const AGENT_CLI_METADATA = {
  kiro: {
    label: 'Kiro',
    modelLabel: 'Kiro',
    description: 'AWS Kiro CLI — device-flow SSO authentication',
    credentialProvider: 'kiro',
    modelHelp: {
      label: 'Kiro model IDs',
      url: 'https://kiro.dev/docs/',
    },
    modelPlaceholder: 'Model ID',
  },
  claude: {
    label: 'Claude Code',
    modelLabel: 'Claude',
    description: 'Anthropic Claude Code — AWS Bedrock authentication',
    credentialProvider: 'bedrock',
    modelHelp: {
      label: 'Bedrock model IDs',
      url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
    },
    modelPlaceholder: 'us.anthropic.claude-sonnet-4-6',
  },
  opencode: {
    label: 'OpenCode',
    modelLabel: 'OpenCode',
    description: 'OpenCode CLI — AWS Bedrock authentication',
    credentialProvider: 'bedrock',
    modelHelp: {
      label: 'Bedrock model IDs',
      url: 'https://docs.aws.amazon.com/bedrock/latest/userguide/models-supported.html',
    },
    modelPlaceholder: 'amazon-bedrock/us.anthropic.claude-sonnet-4-6',
  },
  codex: {
    label: 'Codex',
    modelLabel: 'Codex',
    description: 'OpenAI Codex CLI — AWS Bedrock authentication (OpenAI models)',
    credentialProvider: 'bedrock',
    modelHelp: {
      label: 'Codex on Bedrock model IDs',
      url: 'https://help.openai.com/en/articles/20001252-use-codex-with-amazon-bedrock',
    },
    modelPlaceholder: 'global.openai.gpt-5.6-sol',
  },
} as const satisfies Record<AgentCli, AgentCliMetadata>;

export const AGENT_CREDENTIAL_SOURCE_LABELS = {
  user: 'Personal',
  space: 'Space',
  platform: 'Platform',
} as const satisfies Record<AgentCredentialSource, string>;

/** Name a resolved credential by scope AND kind.
 *
 * An IAM-role binding stores no secret, so calling it a "key" is wrong — the
 * platform settings page says so in terms ("No secret is stored"). A kind the
 * platform could not determine yields the scope alone rather than a guessed
 * noun, because an unlabelled badge is accurate and a wrong one is not. */
export const credentialBadgeLabel = (
  source: AgentCredentialSource,
  kind?: BedrockCredentialMode,
): string => {
  const scope = AGENT_CREDENTIAL_SOURCE_LABELS[source];
  if (kind === 'role') return `${scope} IAM role`;
  if (kind === 'bearer') return `${scope} key`;
  return scope;
};
