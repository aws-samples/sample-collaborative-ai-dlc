import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor, within } from '@/test/query';
import { ApiError } from '@/services/api';
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
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';

// Stored and missing keys are summary rows; the input appears after Add/Rotate.
const BEDROCK = /^(Add|Rotate) Bedrock key$/;
const KIRO = /^(Add|Rotate) Kiro key$/;
const GATEWAY = /^(Add|Rotate) gateway key$/;
const openField = async (
  user: ReturnType<typeof userEvent.setup>,
  action: RegExp,
  label: RegExp,
) => {
  await user.click(await screen.findByRole('button', { name: action }));
  return screen.getByLabelText(label);
};

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

    expect(await screen.findByRole('button', { name: 'Add Bedrock key' })).toBeVisible();
    expect(screen.queryByLabelText(/Bedrock Bearer Token/)).not.toBeInTheDocument();
    const token = await openField(user, BEDROCK, /Bedrock Bearer Token/);
    expect(token).toHaveValue('');
    await user.type(token, 'personal-token');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));

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

    await user.type(await openField(user, KIRO, /Kiro API Key/), 'space-key');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));

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

    const spaceAKey = await openField(user, /^Add Kiro key$/, /Kiro API Key/);
    await user.type(spaceAKey, 'space-a-key');
    expect(spaceAKey).toHaveValue('space-a-key');

    rerender(<AgentCredentialScopeCard scope="space" projectId="space-b" />);

    expect(await screen.findByRole('button', { name: 'Rotate Kiro key' })).toBeVisible();
    expect(screen.queryByLabelText(/Kiro API Key/)).not.toBeInTheDocument();
    const spaceBKey = await openField(user, /^Rotate Kiro key$/, /Kiro API Key/);
    expect(spaceBKey).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Save credentials' })).toBeDisabled();
  });

  it('ignores a delayed response from the previous space', async () => {
    const lateSpaceA = deferred<typeof SPACE_A_STATUS>();
    getProjectCredentials.mockImplementation((projectId) =>
      projectId === 'space-a' ? lateSpaceA.promise : Promise.resolve(SPACE_B_STATUS),
    );
    const { rerender } = render(<AgentCredentialScopeCard scope="space" projectId="space-a" />);
    await waitFor(() => expect(getProjectCredentials).toHaveBeenCalledWith('space-a'));

    rerender(<AgentCredentialScopeCard scope="space" projectId="space-b" />);

    expect(await screen.findByRole('button', { name: 'Add Bedrock key' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rotate Kiro key' })).toBeVisible();

    await act(async () => {
      lateSpaceA.resolve(SPACE_A_STATUS);
      await lateSpaceA.promise;
    });

    expect(screen.getByRole('button', { name: 'Add Bedrock key' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Rotate Kiro key' })).toBeVisible();
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

    await user.type(await openField(user, KIRO, /Kiro API Key/), 'space-a-key');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));
    expect(screen.getByRole('button', { name: 'Saving…' })).toBeDisabled();

    rerender(<AgentCredentialScopeCard scope="space" projectId="space-b" />);

    await screen.findByRole('button', { name: 'Rotate Kiro key' });
    expect(screen.queryByRole('button', { name: 'Save credentials' })).not.toBeInTheDocument();

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

    const kiro = await openField(user, KIRO, /Kiro API Key/);
    await user.type(kiro, 'bedrock-api-key-example');
    expect(screen.getByRole('status')).toHaveTextContent(/starts with "ksk_"/);
    expect(kiro).toHaveAccessibleDescription(/starts with "ksk_"/);

    await user.click(screen.getByRole('button', { name: 'Save credentials' }));
    await waitFor(() =>
      expect(updatePersonalCredentials).toHaveBeenCalledWith({
        kiroApiKey: 'bedrock-api-key-example',
      }),
    );
  });

  it('shows no hint for a Kiro API key in the Kiro field', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    const kiro = await openField(user, KIRO, /Kiro API Key/);
    await user.type(kiro, 'ksk_example');
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
    expect(kiro).not.toHaveAttribute('aria-describedby');
  });

  it('hints when a Kiro API key is entered in the Bedrock field', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

    await user.type(await openField(user, BEDROCK, /Bedrock Bearer Token/), 'ksk_example');
    expect(screen.getByRole('status')).toHaveTextContent(/It goes in Kiro API Key/);
  });

  describe('with a Bedrock gateway', () => {
    it('takes a gateway key in the Bedrock field and says which agents can use it', async () => {
      const user = userEvent.setup();
      getProjectCredentials.mockResolvedValue({
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        bedrockGatewayUrl: 'https://gateway.example.com/bedrock',
        platformFallback: { bedrockBearerTokenSet: true, kiroApiKeySet: false },
      });
      render(<AgentCredentialScopeCard scope="space" projectId="space-a" />);

      const key = await openField(user, GATEWAY, /Bedrock Gateway Key/);
      expect(key).toHaveAttribute('placeholder', 'Paste your gateway key');
      expect(
        screen.getByText(
          'Sent to the Bedrock gateway at gateway.example.com. Enables Claude Code; OpenCode and Codex cannot use a gateway. A platform fallback is available.',
        ),
      ).toBeVisible();
      expect(screen.queryByLabelText(/Bedrock Bearer Token/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Enables Claude Code, OpenCode and Codex/)).not.toBeInTheDocument();

      // The same write as a Bedrock key: the gateway changes where it is sent, not how it is stored.
      await user.type(key, 'gateway-test-key');
      await user.click(screen.getByRole('button', { name: 'Save credentials' }));
      await waitFor(() =>
        expect(updateProjectCredentials).toHaveBeenCalledWith('space-a', {
          bedrockBearerToken: 'gateway-test-key',
        }),
      );
    });

    it('names the gateway key in the hint for a key in the wrong field', async () => {
      const user = userEvent.setup();
      getProjectCredentials.mockResolvedValue({
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        bedrockGatewayUrl: 'https://gateway.example.com',
      });
      render(<AgentCredentialScopeCard scope="space" projectId="space-a" />);

      await user.type(await openField(user, GATEWAY, /Bedrock Gateway Key/), 'ksk_example');
      expect(screen.getByRole('status')).toHaveTextContent(
        /this field takes a Bedrock gateway key/,
      );
    });

    it('keeps the Bedrock wording when the backend reports no gateway', async () => {
      const user = userEvent.setup();
      render(<AgentCredentialScopeCard scope="personal" />);

      expect(await openField(user, BEDROCK, /Bedrock Bearer Token/)).toHaveAttribute(
        'placeholder',
        'Paste your Bedrock bearer token',
      );
      expect(screen.getByText('Enables Claude Code, OpenCode and Codex.')).toBeVisible();
      expect(screen.queryByText(/Bedrock gateway/)).not.toBeInTheDocument();
    });
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

    expect(await screen.findByText('Using your own Bedrock key')).toBeInTheDocument();
    expect(getPersonalCredentials).toHaveBeenCalledTimes(2);
  });

  it('reports a failed refresh of shown credentials with Retry, not as Saved', async () => {
    queryClient.setQueryData(qk.personalCredentials(), {
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
    });
    getPersonalCredentials
      .mockRejectedValueOnce(new Error('Credential service unavailable'))
      .mockResolvedValueOnce({ bedrockBearerTokenSet: true, kiroApiKeySet: false });
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't refresh credentials");
    expect(alert).toHaveTextContent('Credential service unavailable');
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
    // The shown record stays.
    expect(screen.getByText('Using your own Bedrock key')).toBeInTheDocument();

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).not.toBeInTheDocument());
    expect(getPersonalCredentials).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Saved')).not.toBeInTheDocument();
  });

  it('says Saved after a successful save, and a failed reread after it is a refresh problem', async () => {
    getPersonalCredentials
      .mockResolvedValueOnce({ bedrockBearerTokenSet: false, kiroApiKeySet: false })
      .mockRejectedValueOnce(new Error('Credential service unavailable'));
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);

    await user.type(await openField(user, KIRO, /Kiro API Key/), 'kiro-key');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));

    expect(await screen.findByText('Saved')).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent("Couldn't refresh credentials");
    expect(screen.queryByText(/Failed to save/)).not.toBeInTheDocument();
  });

  describe('keyboard focus', () => {
    it('moves into the input a row opens and back to that row on Cancel', async () => {
      getPersonalCredentials.mockResolvedValue({
        bedrockBearerTokenSet: true,
        kiroApiKeySet: false,
      });
      const user = userEvent.setup();
      render(<AgentCredentialScopeCard scope="personal" />);

      (await screen.findByRole('button', { name: 'Rotate Bedrock key' })).focus();
      await user.keyboard('{Enter}');
      expect(screen.getByLabelText(/Bedrock Bearer Token/)).toHaveFocus();

      await user.click(screen.getByRole('button', { name: 'Cancel' }));
      expect(screen.getByRole('button', { name: 'Rotate Bedrock key' })).toHaveFocus();
    });

    it('returns to the saved row once the save succeeds', async () => {
      getPersonalCredentials
        .mockResolvedValueOnce({ bedrockBearerTokenSet: false, kiroApiKeySet: false })
        .mockResolvedValueOnce({ bedrockBearerTokenSet: false, kiroApiKeySet: true });
      const user = userEvent.setup();
      render(<AgentCredentialScopeCard scope="personal" />);

      (await screen.findByRole('button', { name: 'Add Kiro key' })).focus();
      await user.keyboard('{Enter}');
      const input = screen.getByLabelText(/Kiro API Key/);
      expect(input).toHaveFocus();
      await user.type(input, 'kiro-key');
      await user.click(screen.getByRole('button', { name: 'Save credentials' }));

      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Rotate Kiro key' })).toHaveFocus(),
      );
    });
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
      // The server rejects any Bedrock key write in this mode, so nothing offers one.
      expect(screen.queryByLabelText(/Bedrock Bearer Token/)).not.toBeInTheDocument();
      expect(
        screen.getByText(
          'Agents in this space get Bedrock access through Test gateway, so a space Bedrock key is not used.',
        ),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          'A Bedrock key is still saved here, but it is not used while Test gateway is active.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Clear/ })).not.toBeInTheDocument();
      expect(screen.queryByText(/Enables Claude Code/)).not.toBeInTheDocument();

      const kiro = await openField(user, KIRO, /Kiro API Key/);
      expect(kiro).toBeEnabled();
      await user.type(kiro, 'ksk_space');
      await user.click(screen.getByRole('button', { name: 'Save credentials' }));
      await waitFor(() =>
        expect(updateProjectCredentials).toHaveBeenCalledWith('space-1', {
          kiroApiKey: 'ksk_space',
        }),
      );
    });

    it('shows a person the shared access instead of a Bedrock key they cannot use', async () => {
      getPersonalCredentials.mockResolvedValue({
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        authentication: connectionView({
          reviewRequired: false,
          connection: {
            ...connectionView().connection!,
            configuration: { endpoint: 'https://gateway.example', region: 'eu-west-1' },
          },
        }),
      });
      const user = userEvent.setup();
      render(<AgentCredentialScopeCard scope="personal" />);

      const access = await screen.findByRole('region', { name: 'Platform default Bedrock access' });
      expect(access).toHaveTextContent('Platform default Bedrock access: Test gateway');
      expect(access).toHaveTextContent('Status: Ready');
      expect(access).toHaveTextContent('Endpoint: https://gateway.example');
      expect(access).toHaveTextContent('Region: eu-west-1');
      expect(screen.queryByLabelText(/Bedrock Bearer Token/)).not.toBeInTheDocument();
      expect(
        screen.getByText(
          "Your administrators provide Bedrock access through Test gateway, so you don't need a Bedrock key.",
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/still saved here/)).not.toBeInTheDocument();

      await user.type(await openField(user, KIRO, /Kiro API Key/), 'ksk_personal');
      await user.click(screen.getByRole('button', { name: 'Save credentials' }));
      await waitFor(() =>
        expect(updatePersonalCredentials).toHaveBeenCalledWith({ kiroApiKey: 'ksk_personal' }),
      );
    });

    it('marks a stale personal Bedrock key as unused without offering to clear it', async () => {
      getPersonalCredentials.mockResolvedValue({
        bedrockBearerTokenSet: true,
        kiroApiKeySet: false,
        authentication: connectionView({
          connection: { ...connectionView().connection!, state: 'reconnect-required' },
        }),
      });
      render(<AgentCredentialScopeCard scope="personal" />);

      expect(
        await screen.findByText(
          'A Bedrock key is still saved here, but it is not used while Test gateway is active.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: /Clear/ })).not.toBeInTheDocument();
      expect(
        screen.getByText('Status: Needs reconnecting by an administrator'),
      ).toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent('administrator must reconnect');
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

  it('explains a Bedrock key refused because the mode changed after the page loaded', async () => {
    updatePersonalCredentials.mockRejectedValueOnce(
      new ApiError(409, 'Bedrock key overrides are unavailable in the active platform mode', {
        error: 'Bedrock key overrides are unavailable in the active platform mode',
        code: 'AGENT_AUTH_MODE_MISMATCH',
      }),
    );
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="personal" />);
    await user.type(await openField(user, BEDROCK, /Bedrock Bearer Token/), 'personal-token');
    await user.click(screen.getByRole('button', { name: 'Save credentials' }));

    expect(
      await screen.findByText(
        "Your administrators now manage Bedrock access, so a Bedrock key can't be used. Reload the page to see the current setup.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/unavailable in the active platform mode/)).not.toBeInTheDocument();
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
    expect(screen.getByRole('button', { name: 'Rotate Bedrock key' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Clear Bedrock key' })).toBeEnabled();
  });

  describe('space status (CF4)', () => {
    it('says the space uses the platform keys when nothing is overridden, in a neutral tone', async () => {
      render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);

      const status = await screen.findByText('Uses platform keys');
      expect(status).toHaveAttribute('data-tone', 'neutral');
      expect(screen.queryByText('No credentials')).not.toBeInTheDocument();
    });

    it('does not claim platform keys when the platform has none', async () => {
      getProjectCredentials.mockResolvedValue({
        bedrockBearerTokenSet: false,
        kiroApiKeySet: false,
        platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
      });
      const { rerender } = render(<AgentCredentialScopeCard scope="space" projectId="space-1" />);
      expect(await screen.findByText('No keys set')).toBeInTheDocument();
      expect(screen.queryByText('Uses platform keys')).not.toBeInTheDocument();

      rerender(
        <AgentCredentialScopeCard
          scope="space"
          projectId="space-1"
          requiredProviders={['bedrock']}
        />,
      );
      expect(await screen.findByText('Bedrock key missing')).toHaveAttribute(
        'data-tone',
        'warning',
      );
    });

    it("names the missing key even when the space has a key the agents don't use", async () => {
      getProjectCredentials.mockResolvedValue({
        bedrockBearerTokenSet: false,
        kiroApiKeySet: true,
        platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
      });
      render(
        <AgentCredentialScopeCard
          scope="space"
          projectId="space-1"
          requiredProviders={['bedrock']}
        />,
      );
      expect(await screen.findByText('Bedrock key missing')).toBeInTheDocument();
      expect(screen.queryByText('1 provider configured')).not.toBeInTheDocument();
    });

    it('warns only when an enabled CLI has no key at any level', async () => {
      const { rerender } = render(
        <AgentCredentialScopeCard
          scope="space"
          projectId="space-1"
          requiredProviders={['bedrock']}
        />,
      );
      expect(await screen.findByText('Uses platform keys')).toHaveAttribute('data-tone', 'neutral');

      rerender(
        <AgentCredentialScopeCard
          scope="space"
          projectId="space-1"
          requiredProviders={['bedrock', 'kiro']}
        />,
      );
      expect(await screen.findByText('Kiro key missing')).toHaveAttribute('data-tone', 'warning');
    });
  });

  describe('as a disclosure (Space › Agent)', () => {
    it('stays collapsed while the space inherits the platform keys', async () => {
      render(
        <AgentCredentialScopeCard scope="space" projectId="space-1" presentation="disclosure" />,
      );

      expect(await screen.findAllByText('Uses platform keys')).not.toHaveLength(0);
      const trigger = screen.getByRole('button', { name: 'Agent credentials' });
      expect(trigger).toHaveAttribute('aria-expanded', 'false');
      expect(screen.getByRole('button', { name: 'Add Kiro key', hidden: true })).not.toBeVisible();
    });

    it('opens when the space has its own key', async () => {
      getProjectCredentials.mockResolvedValue(SPACE_B_STATUS);
      render(
        <AgentCredentialScopeCard scope="space" projectId="space-1" presentation="disclosure" />,
      );

      expect(await screen.findAllByText('1 provider configured')).not.toHaveLength(0);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Agent credentials' })).toHaveAttribute(
          'aria-expanded',
          'true',
        ),
      );
      expect(screen.getByRole('button', { name: 'Rotate Kiro key' })).toBeVisible();
    });

    it('opens when an enabled CLI has no key anywhere', async () => {
      render(
        <AgentCredentialScopeCard
          scope="space"
          projectId="space-1"
          presentation="disclosure"
          requiredProviders={['kiro']}
        />,
      );

      expect(await screen.findAllByText('Kiro key missing')).not.toHaveLength(0);
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Agent credentials' })).toHaveAttribute(
          'aria-expanded',
          'true',
        ),
      );
    });

    it('can be opened by the person to add a key', async () => {
      const user = userEvent.setup();
      render(
        <AgentCredentialScopeCard scope="space" projectId="space-1" presentation="disclosure" />,
      );

      await screen.findAllByText('Uses platform keys');
      await user.click(screen.getByRole('button', { name: 'Agent credentials' }));
      await user.type(await openField(user, KIRO, /Kiro API Key/), 'space-key');
      await user.click(screen.getByRole('button', { name: 'Save credentials' }));
      await waitFor(() =>
        expect(updateProjectCredentials).toHaveBeenCalledWith('space-1', {
          kiroApiKey: 'space-key',
        }),
      );
    });
  });
});
