import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { AgentAuthenticationView } from '@/services/agents';
import type { AgentAuthProviderUi, AgentAuthSetupProps } from './agent-auth/contract';

const getPersonalCredentials = vi.fn();
const updatePersonalCredentials = vi.fn();
const getProjectCredentials = vi.fn();
const updateProjectCredentials = vi.fn();

vi.mock('@/services/agents', () => ({
  agentsService: {
    getPersonalCredentials: (...args: unknown[]) => getPersonalCredentials(...args),
    updatePersonalCredentials: (...args: unknown[]) => updatePersonalCredentials(...args),
    getProjectCredentials: (...args: unknown[]) => getProjectCredentials(...args),
    updateProjectCredentials: (...args: unknown[]) => updateProjectCredentials(...args),
  },
}));

vi.mock('./agent-auth/registry', () => {
  const ui: AgentAuthProviderUi = {
    mode: 'test-connection',
    noun: 'test link',
    Setup: ({ scope, projectId }: AgentAuthSetupProps) => (
      <p>
        Test setup for {scope} {projectId}
      </p>
    ),
  };
  return {
    AGENT_AUTH_PROVIDER_UIS: [ui],
    agentAuthProviderUi: (mode?: string | null) => (mode === ui.mode ? ui : undefined),
  };
});

import { AgentCredentialScopeCard } from './AgentCredentialScopeCard';

const SPACE_A_STATUS = {
  bedrockBearerTokenSet: true,
  kiroApiKeySet: false,
  platformFallback: {
    bedrockBearerTokenSet: true,
    kiroApiKeySet: false,
  },
};

const SPACE_B_STATUS = {
  bedrockBearerTokenSet: false,
  kiroApiKeySet: true,
  platformFallback: {
    bedrockBearerTokenSet: false,
    kiroApiKeySet: true,
  },
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};

beforeEach(() => {
  vi.clearAllMocks();
  getPersonalCredentials.mockResolvedValue({
    bedrockBearerTokenSet: false,
    kiroApiKeySet: false,
  });
  updatePersonalCredentials.mockResolvedValue({ saved: true });
  getProjectCredentials.mockResolvedValue({
    bedrockBearerTokenSet: false,
    kiroApiKeySet: false,
    platformFallback: {
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
    },
  });
  updateProjectCredentials.mockResolvedValue({ saved: true });
});

describe('AgentCredentialScopeCard', () => {
  it('writes a personal credential without reading a secret value back', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    const token = await screen.findByLabelText(/Bedrock Bearer Token/);
    expect(token).toHaveValue('');
    await user.type(token, 'personal-token');
    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));

    await waitFor(() =>
      expect(updatePersonalCredentials).toHaveBeenCalledWith({
        bedrockBearerToken: 'personal-token',
      }),
    );
    expect(getPersonalCredentials).toHaveBeenCalledTimes(2);
  });

  it('shows platform inheritance and writes credentials to the requested space', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

    expect(await screen.findByText(/A platform fallback is available/)).toBeInTheDocument();
    expect(screen.getByText(/No platform fallback is set/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Kiro API Key/), 'space-key');
    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));

    await waitFor(() =>
      expect(updateProjectCredentials).toHaveBeenCalledWith('space-1', {
        kiroApiKey: 'space-key',
      }),
    );
  });

  it('clears write-only drafts when the space changes', async () => {
    getProjectCredentials.mockImplementation((projectId) =>
      Promise.resolve(projectId === 'space-a' ? SPACE_A_STATUS : SPACE_B_STATUS),
    );
    const user = userEvent.setup();
    const { rerender } = render(<AgentCredentialScopeCard scope="space" projectId="space-a" />);

    const spaceAKey = await screen.findByLabelText(/Kiro API Key/);
    await user.type(spaceAKey, 'space-a-key');
    expect(spaceAKey).toHaveValue('space-a-key');

    rerender(<AgentCredentialScopeCard scope="space" projectId="space-b" />);

    const spaceBKey = await screen.findByLabelText(/Kiro API Key/);
    expect(spaceBKey).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save Credentials' })).toBeDisabled();
  });

  it('ignores a delayed response from the previous space', async () => {
    const lateSpaceA = deferred<typeof SPACE_A_STATUS>();
    getProjectCredentials.mockImplementation((projectId) =>
      projectId === 'space-a' ? lateSpaceA.promise : Promise.resolve(SPACE_B_STATUS),
    );
    const { rerender } = render(<AgentCredentialScopeCard scope="space" projectId="space-a" />);
    await waitFor(() => expect(getProjectCredentials).toHaveBeenCalledWith('space-a'));

    rerender(<AgentCredentialScopeCard scope="space" projectId="space-b" />);

    const bedrock = await screen.findByLabelText(/Bedrock Bearer Token/);
    const kiro = screen.getByLabelText(/Kiro API Key/);
    expect(bedrock).toHaveAttribute('placeholder', 'Enter AWS_BEARER_TOKEN_BEDROCK value');
    expect(kiro).toHaveAttribute('placeholder', 'Enter a new key to rotate, or leave blank');

    await act(async () => {
      lateSpaceA.resolve(SPACE_A_STATUS);
      await lateSpaceA.promise;
    });

    expect(bedrock).toHaveAttribute('placeholder', 'Enter AWS_BEARER_TOKEN_BEDROCK value');
    expect(kiro).toHaveAttribute('placeholder', 'Enter a new key to rotate, or leave blank');
  });

  it('drops an in-flight save when the space changes', async () => {
    const pendingSpaceAUpdate = deferred<{ saved: boolean }>();
    getProjectCredentials.mockImplementation((projectId) =>
      Promise.resolve(projectId === 'space-a' ? SPACE_A_STATUS : SPACE_B_STATUS),
    );
    updateProjectCredentials.mockImplementation((projectId) =>
      projectId === 'space-a' ? pendingSpaceAUpdate.promise : Promise.resolve({ saved: true }),
    );
    const user = userEvent.setup();
    const { rerender } = render(<AgentCredentialScopeCard scope="space" projectId="space-a" />);

    await user.type(await screen.findByLabelText(/Kiro API Key/), 'space-a-key');
    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    rerender(<AgentCredentialScopeCard scope="space" projectId="space-b" />);

    await screen.findByLabelText(/Kiro API Key/);
    expect(screen.getByRole('button', { name: 'Save Credentials' })).toBeDisabled();

    await act(async () => {
      pendingSpaceAUpdate.resolve({ saved: true });
      await pendingSpaceAUpdate.promise;
    });

    expect(
      getProjectCredentials.mock.calls.filter(([projectId]) => projectId === 'space-a'),
    ).toHaveLength(1);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('hints that a non-Kiro value may be in the wrong field, without blocking the save', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    const kiro = await screen.findByLabelText(/Kiro API Key/);
    await user.type(kiro, 'bedrock-api-key-example');
    expect(screen.getByRole('status')).toHaveTextContent(/starts with "ksk_"/);
    expect(kiro).toHaveAccessibleDescription(/starts with "ksk_"/);

    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));
    await waitFor(() =>
      expect(updatePersonalCredentials).toHaveBeenCalledWith({
        kiroApiKey: 'bedrock-api-key-example',
      }),
    );
  });

  it('shows no hint for a Kiro API key in the Kiro field', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    const kiro = await screen.findByLabelText(/Kiro API Key/);
    await user.type(kiro, 'ksk_example');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(kiro).not.toHaveAttribute('aria-describedby');
  });

  it('hints when a Kiro API key is entered in the Bedrock field', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

    await user.type(await screen.findByLabelText(/Bedrock Bearer Token/), 'ksk_example');
    expect(screen.getByRole('status')).toHaveTextContent(/It goes in Kiro API Key/);
  });

  it('surfaces a load failure and retries', async () => {
    getPersonalCredentials
      .mockRejectedValueOnce(new Error('Credential service unavailable'))
      .mockResolvedValueOnce({
        bedrockBearerTokenSet: true,
        kiroApiKeySet: false,
      });
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    expect(await screen.findByRole('alert')).toHaveTextContent('Credential service unavailable');
    await user.click(screen.getByRole('button', { name: 'Retry' }));

    expect(await screen.findByText('1 provider configured')).toBeInTheDocument();
    expect(getPersonalCredentials).toHaveBeenCalledTimes(2);
  });

  describe('in a connection mode', () => {
    const connectionView = (
      overrides: Partial<AgentAuthenticationView> = {},
    ): AgentAuthenticationView => ({
      policy: { mode: 'test-connection', revision: 2, defaultConnectionId: 'test-platform' },
      modes: [
        { id: 'keys', label: 'Keys', available: true },
        { id: 'test-connection', label: 'Test gateway', available: true },
      ],
      reviewRequired: true,
      personalMechanisms: [],
      hasOverride: false,
      canManageConnections: false,
      connection: {
        id: 'test-platform',
        mode: 'test-connection',
        backend: 'bedrock',
        mechanism: 'oauth-machine',
        source: 'platform',
        state: 'ready',
        configuration: {},
      },
      ...overrides,
    });

    it('shows an inherited ready connection and keeps saved Bedrock keys inert', async () => {
      getProjectCredentials.mockResolvedValue({
        ...SPACE_A_STATUS,
        authentication: connectionView({ reviewRequired: false }),
      });
      const user = userEvent.setup();
      render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

      expect(await screen.findByText('Using platform connection')).toBeInTheDocument();
      expect(screen.queryByText('1 provider configured')).not.toBeInTheDocument();
      expect(screen.getByText(/Inherits platform connection/)).toBeInTheDocument();
      expect(
        screen.getByText(/inherit the platform Test gateway connection unless this space/),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/Bedrock Bearer Token/)).toBeDisabled();
      expect(screen.getByText(/Saved Bedrock keys are not used in this mode/)).toBeInTheDocument();
      expect(screen.queryByText(/Enables Claude Code/)).not.toBeInTheDocument();

      const kiro = screen.getByLabelText(/Kiro API Key/);
      expect(kiro).toBeEnabled();
      await user.type(kiro, 'ksk_space');
      await user.click(screen.getByRole('button', { name: 'Save Credentials' }));
      await waitFor(() =>
        expect(updateProjectCredentials).toHaveBeenCalledWith('space-1', {
          kiroApiKey: 'ksk_space',
        }),
      );
    });

    it('does not let a saved key hide an unavailable override', async () => {
      getProjectCredentials.mockResolvedValue({
        ...SPACE_A_STATUS,
        authentication: connectionView({
          hasOverride: true,
          connection: {
            id: 'test-space',
            mode: 'test-connection',
            backend: 'bedrock',
            mechanism: 'oauth-machine',
            source: 'space',
            projectId: 'space-1',
            state: 'revoked',
            configuration: {},
          },
        }),
      });
      render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

      expect(await screen.findByText('Test gateway needs attention')).toBeInTheDocument();
      expect(screen.queryByText('1 provider configured')).not.toBeInTheDocument();
      expect(screen.getByText(/Space test link override/)).toBeInTheDocument();
    });

    it('marks a space-owned ready connection as configured and hands Setup the space', async () => {
      getProjectCredentials.mockResolvedValue({
        ...SPACE_B_STATUS,
        authentication: connectionView({
          hasOverride: true,
          canManageConnections: true,
          connection: {
            id: 'test-space',
            mode: 'test-connection',
            backend: 'bedrock',
            mechanism: 'oauth-machine',
            source: 'space',
            projectId: 'space-1',
            state: 'ready',
            configuration: {},
          },
        }),
      });
      const user = userEvent.setup();
      render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

      expect(await screen.findByText('Test gateway configured')).toBeInTheDocument();
      await user.click(screen.getByRole('button', { name: 'Change space test link' }));
      expect(screen.getByText('Test setup for space space-1')).toBeInTheDocument();
    });
  });

  it('falls back to the saved space key when the server omits hasOverride', async () => {
    getProjectCredentials.mockResolvedValue({
      ...SPACE_A_STATUS,
      authentication: {
        policy: { mode: 'keys', revision: 1, defaultConnectionId: 'keys-platform' },
        modes: [{ id: 'keys', label: 'Keys', available: true }],
        reviewRequired: true,
        personalMechanisms: ['api-key'],
        connection: null,
      },
    });
    render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

    expect(await screen.findByText(/Space key override/)).toBeInTheDocument();
    expect(screen.getByText('1 provider configured')).toBeInTheDocument();
    expect(screen.getByLabelText(/Bedrock Bearer Token/)).toBeEnabled();
  });
});
