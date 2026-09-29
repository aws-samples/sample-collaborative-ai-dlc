import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type {
  AgentAuthenticationView,
  AgentAuthImpactReview,
  AgentConnectionView,
} from '@/services/agents';

const { preview, apply, providerAction, getProjectCredentials } = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
  providerAction: vi.fn(),
  getProjectCredentials: vi.fn(),
}));

vi.mock('@/services/agents', () => ({
  agentsService: {
    previewAuthenticationChange: (...args: unknown[]) => preview(...args),
    applyAuthenticationChange: (...args: unknown[]) => apply(...args),
    authenticationProviderAction: (...args: unknown[]) => providerAction(...args),
    getProjectCredentials: (...args: unknown[]) => getProjectCredentials(...args),
  },
}));

// The real composition root: the generic shells render the registered IAM UI.
import { AgentAuthenticationModeSettings } from '../../AgentAuthenticationModeSettings';
import { AgentCredentialScopeCard } from '../../AgentCredentialScopeCard';
import { agentAuthProviderUi } from '../registry';
import { bedrockIamUi } from './index';

const config = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
const spaceConnection: AgentConnectionView = {
  id: 'iam-space',
  revision: 1,
  mode: 'iam',
  backend: 'bedrock',
  mechanism: 'assume-role',
  source: 'space',
  projectId: 'p',
  state: 'ready',
  configuration: config,
};
const authentication: AgentAuthenticationView = {
  policy: { mode: 'iam', revision: 1, defaultConnectionId: 'iam-platform' },
  modes: [
    { id: 'keys', label: 'Keys', available: true, defaultConnectionId: 'legacy-platform-bedrock' },
    { id: 'iam', label: 'IAM', available: true },
  ],
  reviewRequired: true,
  canManageConnections: true,
  personalMechanisms: [],
  connection: spaceConnection,
};
const reviewOf = (candidate: AgentAuthImpactReview['candidate']): AgentAuthImpactReview => ({
  id: 'review',
  createdAt: new Date().toISOString(),
  policyRevision: 1,
  candidate,
  complete: true,
  limitations: [],
  counts: {},
  items: [],
});
const setupDocument = {
  brokerRoleArn: 'arn:aws:iam::111111111111:role/runtime',
  applicationAccountId: '111111111111',
  inferenceAccountId: '222222222222',
  trustPolicy: { Statement: ['trust'] },
  assumeRolePolicy: { Statement: ['assume'] },
  inferencePolicy: { Statement: ['inference'] },
  inferenceCommands: '# inference account commands',
  applicationCommands: '# application account commands',
  reuseCommands: '# reuse role commands',
};

// Completes the real wizard for a role it opened with, as an administrator would.
const verifyAndSubmit = async (user: ReturnType<typeof userEvent.setup>) => {
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Continue to connection test' })).toBeEnabled(),
  );
  await user.click(screen.getByRole('button', { name: 'Continue to connection test' }));
  await user.click(await screen.findByRole('button', { name: 'Test connection' }));
  await screen.findByRole('status');
  await user.click(screen.getByRole('button', { name: 'Review connection change' }));
};
const impactReview = () => screen.findByRole('region', { name: 'Authentication change impact' });

beforeEach(() => {
  vi.resetAllMocks();
  preview.mockImplementation(
    async (request: { kind?: string; projectId?: string; configuration?: object }) =>
      reviewOf(
        request.kind === 'connection-draft'
          ? {
              kind: 'connection-create',
              source: request.projectId ? 'space' : 'platform',
              ...(request.projectId ? { projectId: request.projectId } : {}),
              select: true,
              connection: {
                ...spaceConnection,
                id: 'iam-next',
                source: request.projectId ? 'space' : 'platform',
                projectId: request.projectId,
                configuration: { ...request.configuration },
              },
            }
          : request.kind === 'space-selection'
            ? { kind: 'space-selection', source: 'space', projectId: 'p', connectionId: null }
            : {
                kind: 'policy-change',
                mode: 'keys',
                defaultConnectionId: 'legacy-platform-bedrock',
              },
      ),
  );
  apply.mockResolvedValue({ saved: true });
  providerAction.mockImplementation(
    async (_mode: string, action: string, body: { config?: object }) =>
      action === 'defaults'
        ? { brokerRoleArn: setupDocument.brokerRoleArn, region: 'us-east-1' }
        : action === 'setup'
          ? { ...setupDocument, config: body.config }
          : { verified: true, models: [{ id: 'eu.anthropic.claude-sonnet-4-6' }] },
  );
});

describe('Bedrock IAM provider UI', () => {
  it('registers the IAM role UI and summarizes only the role and region', () => {
    expect(agentAuthProviderUi('iam')).toBe(bedrockIamUi);
    expect(bedrockIamUi.noun).toBe('IAM role');
    expect(bedrockIamUi.summarize?.({ ...config, externalId: 'external-fixture' })).toEqual([
      { label: 'Role', value: config.roleArn },
      { label: 'Region', value: config.region },
    ]);
    expect(bedrockIamUi.summarize?.({ endpoint: 'https://gateway.example' })).toEqual([]);
  });
});

describe('reviewed IAM controls', () => {
  it('previews a verified space role, displays its destination and applies only after confirmation', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn(async () => {});
    render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="space"
        projectId="p"
        hasOverride
        onApplied={onApplied}
      />,
    );
    expect(screen.getByText(/Space IAM role override/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change space IAM role' }));
    expect(screen.getByRole('dialog', { name: 'Set up space IAM' })).toBeInTheDocument();
    await verifyAndSubmit(user);

    const review = await impactReview();
    expect(within(review).getByText('Proposed space IAM role')).toBeInTheDocument();
    expect(within(review).getByText(`Role: ${config.roleArn}`)).toBeInTheDocument();
    expect(within(review).getByText('Region: eu-west-1')).toBeInTheDocument();
    expect(providerAction).toHaveBeenCalledWith('iam', 'verify', { config, projectId: 'p' });
    expect(preview).toHaveBeenCalledWith({
      kind: 'connection-draft',
      mode: 'iam',
      projectId: 'p',
      configuration: config,
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply reviewed change' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('review'));
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('sets up the platform role from keys and never displays its ExternalId', async () => {
    const user = userEvent.setup();
    render(
      <AgentAuthenticationModeSettings
        authentication={{
          ...authentication,
          policy: { mode: 'keys', revision: 1, defaultConnectionId: 'legacy-platform-bedrock' },
          connection: null,
        }}
        scope="platform"
        hasOverride={false}
        onApplied={async () => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'iam');
    await user.click(screen.getByRole('button', { name: 'Set up IAM connection' }));
    expect(screen.getByRole('dialog', { name: 'Set up Bedrock IAM' })).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Generate AWS setup' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('checkbox', { name: 'I already have an inference role' }));
    await user.click(screen.getByText('External ID (optional)'));
    await user.type(
      screen.getByLabelText('External ID required by your AWS administrator'),
      'external-fixture',
    );
    await verifyAndSubmit(user);

    const platformRole = {
      roleArn: 'arn:aws:iam::111111111111:role/CollaborativeBedrock-Platform',
      region: 'us-east-1',
      externalId: 'external-fixture',
    };
    expect(providerAction).toHaveBeenCalledWith('iam', 'defaults', { projectId: undefined });
    expect(providerAction).toHaveBeenCalledWith('iam', 'setup', {
      config: platformRole,
      projectId: undefined,
    });
    expect(preview).toHaveBeenCalledWith({
      kind: 'connection-draft',
      mode: 'iam',
      configuration: platformRole,
    });
    const review = await impactReview();
    expect(within(review).getByText('Proposed platform IAM role')).toBeInTheDocument();
    expect(within(review).getByText(`Role: ${platformRole.roleArn}`)).toBeInTheDocument();
    expect(screen.queryByText(/external-fixture/)).not.toBeInTheDocument();
  });

  it('keeps IAM management unavailable to space admins who are not platform admins', () => {
    render(
      <AgentAuthenticationModeSettings
        authentication={{ ...authentication, canManageConnections: false }}
        scope="space"
        projectId="p"
        hasOverride
        onApplied={async () => {}}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Change space IAM role' })).not.toBeInTheDocument();
    expect(screen.getByText(/Only platform administrators/)).toBeInTheDocument();
  });

  it('reviews removal of a space override and switching the platform back to keys', async () => {
    const user = userEvent.setup();
    const result = render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="space"
        projectId="p"
        hasOverride
        onApplied={async () => {}}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Use platform connection' }));
    expect(preview).toHaveBeenCalledWith({
      kind: 'space-selection',
      projectId: 'p',
      connectionId: null,
    });
    expect(
      await screen.findByText('Use the platform connection for new work in this space.'),
    ).toBeInTheDocument();
    result.unmount();
    render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="platform"
        hasOverride={false}
        onApplied={async () => {}}
      />,
    );
    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'keys');
    await user.click(screen.getByRole('button', { name: 'Review mode change' }));
    expect(preview).toHaveBeenLastCalledWith({
      mode: 'keys',
      defaultConnectionId: 'legacy-platform-bedrock',
    });
    expect(apply).not.toHaveBeenCalled();
  });
});

describe('IAM credential scope card', () => {
  const platformRole = {
    roleArn: 'arn:aws:iam::111111111111:role/Inference',
    region: 'eu-west-1',
  };

  it('shows inherited IAM as configured without requiring a space or platform key', async () => {
    getProjectCredentials.mockResolvedValue({
      bedrockBearerTokenSet: false,
      kiroApiKeySet: false,
      platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
      authentication: {
        ...authentication,
        canManageConnections: false,
        hasOverride: false,
        connection: {
          ...spaceConnection,
          id: 'platform-role',
          source: 'platform',
          projectId: undefined,
          configuration: platformRole,
        },
      },
    });
    render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);
    expect(await screen.findByText('Using platform connection')).toBeInTheDocument();
    expect(screen.queryByText('No credentials')).not.toBeInTheDocument();
    expect(screen.getByText(`Role: ${platformRole.roleArn}`)).toBeInTheDocument();
    expect(screen.getByLabelText(/Bedrock Bearer Token/)).toBeDisabled();
    expect(screen.getByText(/Saved Bedrock keys are not used/)).toBeInTheDocument();
  });

  it('does not let a saved key hide an unavailable IAM connection', async () => {
    getProjectCredentials.mockResolvedValue({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
      platformFallback: { bedrockBearerTokenSet: true, kiroApiKeySet: false },
      authentication: {
        ...authentication,
        policy: { mode: 'iam', revision: 2, defaultConnectionId: 'iam-platform' },
        canManageConnections: false,
        hasOverride: true,
        connection: {
          ...spaceConnection,
          id: 'space-role',
          projectId: 'space-1',
          state: 'revoked',
          configuration: platformRole,
        },
      },
    });
    render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);
    expect(await screen.findByText('IAM needs attention')).toBeInTheDocument();
    expect(screen.queryByText('1 provider configured')).not.toBeInTheDocument();
  });
});
