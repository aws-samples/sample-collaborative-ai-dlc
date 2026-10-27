import { agentsService, type AgentModel } from '@/services/agents';

// A type alias, not an interface, so it is assignable to Setup's onSubmit record.
export type BedrockIamConfig = {
  roleArn: string;
  region: string;
  externalId?: string;
};

export interface BedrockIamSetup {
  config: BedrockIamConfig;
  brokerRoleArn: string;
  applicationAccountId: string;
  inferenceAccountId: string;
  trustPolicy: object;
  assumeRolePolicy: object;
  inferencePolicy: object;
  inferenceCommands: string;
  applicationCommands: string;
  reuseCommands: string;
}

// Served connection configurations are untyped; anything that is not a role
// and region starts a fresh setup instead of prefilling the wizard.
export const parseBedrockIamConfig = (
  configuration?: Readonly<Record<string, unknown>>,
): BedrockIamConfig | undefined => {
  const { roleArn, region, externalId } = configuration ?? {};
  if (typeof roleArn !== 'string' || !roleArn || typeof region !== 'string' || !region)
    return undefined;
  return {
    roleArn,
    region,
    ...(typeof externalId === 'string' && externalId ? { externalId } : {}),
  };
};

// The IAM setup steps behind the generic provider setup route.
export const getBedrockIamDefaults = (
  projectId?: string,
): Promise<{ brokerRoleArn: string; region: string }> =>
  agentsService.authenticationProviderAction('iam', 'defaults', { projectId });

export const generateBedrockIamSetup = (
  config: BedrockIamConfig,
  projectId?: string,
): Promise<BedrockIamSetup> =>
  agentsService.authenticationProviderAction('iam', 'setup', { config, projectId });

export const verifyBedrockIam = (
  config: BedrockIamConfig,
  projectId?: string,
): Promise<{ verified: boolean; models?: AgentModel[]; error?: string; code?: string }> =>
  agentsService.authenticationProviderAction('iam', 'verify', { config, projectId });
