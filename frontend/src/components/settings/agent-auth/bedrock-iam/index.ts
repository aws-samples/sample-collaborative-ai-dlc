import type { AgentAuthProviderUi } from '../contract';
import { parseBedrockIamConfig } from './api';
import { BedrockIamWizard } from './BedrockIamWizard';

export const bedrockIamUi: AgentAuthProviderUi = Object.freeze({
  mode: 'iam',
  noun: 'IAM role',
  Setup: BedrockIamWizard,
  // The ExternalId stays out of summaries and reviews; genericSummary would list it.
  summarize: (configuration: Readonly<Record<string, unknown>>) => {
    const config = parseBedrockIamConfig(configuration);
    return config
      ? [
          { label: 'Role', value: config.roleArn },
          { label: 'Region', value: config.region },
        ]
      : [];
  },
});
