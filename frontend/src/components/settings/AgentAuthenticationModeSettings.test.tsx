import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type {
  AgentAuthenticationView,
  AgentAuthImpactReview,
  AgentConnectionView,
} from '@/services/agents';
import type { AgentAuthProviderUi, AgentAuthSetupProps } from './agent-auth/contract';

const { preview, apply, setupFailure } = vi.hoisted(() => ({
  preview: vi.fn(),
  apply: vi.fn(),
  setupFailure: vi.fn(),
}));

vi.mock('@/services/agents', () => ({
  agentsService: {
    previewAuthenticationChange: (...args: unknown[]) => preview(...args),
    applyAuthenticationChange: (...args: unknown[]) => apply(...args),
  },
}));

// A fake provider stands in for real registrations, so these tests hold for
// any composition root.
vi.mock('./agent-auth/registry', () => {
  const ui: AgentAuthProviderUi = {
    mode: 'test-connection',
    noun: 'test link',
    Setup: ({ scope, projectId, initial, onSubmit, onClose }: AgentAuthSetupProps) => (
      <div role="dialog" aria-label="Test setup">
        <p>
          Setup for {scope} {projectId ?? 'without space'}
        </p>
        <p>Initial: {JSON.stringify(initial ?? null)}</p>
        <button
          type="button"
          onClick={() =>
            void onSubmit({ endpoint: 'https://next.example' }).catch((failure) =>
              setupFailure(failure),
            )
          }
        >
          Submit draft
        </button>
        <button type="button" onClick={onClose}>
          Close setup
        </button>
      </div>
    ),
    summarize: (configuration) => [{ label: 'Gateway', value: String(configuration.endpoint) }],
  };
  return {
    AGENT_AUTH_PROVIDER_UIS: [ui],
    agentAuthProviderUi: (mode?: string | null) => (mode === ui.mode ? ui : undefined),
  };
});

import { AgentAuthenticationModeSettings } from './AgentAuthenticationModeSettings';

const platformConnection: AgentConnectionView = {
  id: 'test-platform',
  revision: 1,
  mode: 'test-connection',
  backend: 'bedrock',
  mechanism: 'oauth-machine',
  source: 'platform',
  state: 'ready',
  configuration: { endpoint: 'https://platform.example' },
};
const spaceConnection: AgentConnectionView = {
  ...platformConnection,
  id: 'test-space',
  source: 'space',
  projectId: 'p1',
  configuration: { endpoint: 'https://space.example' },
};
const view = (overrides: Partial<AgentAuthenticationView> = {}): AgentAuthenticationView => ({
  policy: { mode: 'test-connection', revision: 3, defaultConnectionId: 'test-platform' },
  modes: [
    { id: 'keys', label: 'Keys', available: true, defaultConnectionId: 'keys-platform-default' },
    { id: 'test-connection', label: 'Test gateway', available: true },
    { id: 'plain-mode', label: 'Plain', available: true },
  ],
  reviewRequired: true,
  personalMechanisms: [],
  canManageConnections: true,
  connection: platformConnection,
  ...overrides,
});
const reviewOf = (candidate: AgentAuthImpactReview['candidate']): AgentAuthImpactReview => ({
  id: 'review-1',
  createdAt: '2026-09-24T08:00:00Z',
  policyRevision: 3,
  complete: true,
  candidate,
  limitations: [],
  counts: {},
  items: [],
});

const renderSettings = (
  props: Partial<Parameters<typeof AgentAuthenticationModeSettings>[0]> = {},
) =>
  render(
    <AgentAuthenticationModeSettings
      authentication={view()}
      scope="platform"
      hasOverride={false}
      onApplied={async () => {}}
      {...props}
    />,
  );

// Buttons that act, as opposed to the "How this works" help disclosure.
const actionButtons = () =>
  screen
    .queryAllByRole('button')
    .filter((button) => !/how this works/i.test(button.textContent ?? ''));

const pickMode = async (user: ReturnType<typeof userEvent.setup>, label: string) => {
  await user.click(screen.getByRole('combobox', { name: 'Agent authentication mode' }));
  await user.click(screen.getByRole('option', { name: label }));
};

beforeEach(() => {
  vi.resetAllMocks();
  // Radix Select uses browser APIs that jsdom does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
  preview.mockImplementation(async (request: { kind?: string; projectId?: string }) =>
    reviewOf(
      request.kind === 'connection-draft'
        ? {
            kind: 'connection-create',
            source: request.projectId ? 'space' : 'platform',
            select: true,
            connection: {
              ...platformConnection,
              id: 'test-connection-new',
              source: request.projectId ? 'space' : 'platform',
              configuration: { endpoint: 'https://next.example' },
            },
          }
        : request.kind === 'space-selection'
          ? { kind: 'space-selection', source: 'space', projectId: 'p1', connectionId: null }
          : { kind: 'policy-change', mode: 'keys', defaultConnectionId: 'keys-platform-default' },
    ),
  );
  apply.mockResolvedValue({ saved: true });
});

describe('AgentAuthenticationModeSettings', () => {
  it('picks the mode with the design-system select, keeping the stable id and a label', async () => {
    const user = userEvent.setup();
    renderSettings({
      authentication: view({
        modes: [
          {
            id: 'keys',
            label: 'Keys',
            available: true,
            defaultConnectionId: 'keys-platform-default',
          },
          { id: 'test-connection', label: 'Test gateway', available: true },
          { id: 'later', label: 'Later provider', available: false },
        ],
      }),
    });

    const trigger = screen.getByRole('combobox', { name: 'Agent authentication mode' });
    expect(trigger).toHaveAttribute('id', 'agent-authentication-mode');
    expect(screen.getByLabelText('Agent authentication mode')).toBe(trigger);
    expect(trigger).toHaveTextContent('Test gateway');
    expect(document.querySelector('select')).toBeNull();

    await user.click(trigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual([
      'Keys',
      'Test gateway',
      'Later provider — not available yet',
    ]);
    expect(screen.getByRole('option', { name: /Later provider/ })).toHaveAttribute(
      'aria-disabled',
      'true',
    );
  });

  it('keeps one status line visible and the explanation behind "How this works"', async () => {
    const user = userEvent.setup();
    renderSettings();

    expect(screen.getByText('Connection: Amazon Bedrock · Ready')).toBeInTheDocument();
    expect(screen.queryByText(/Started runs keep/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Kiro uses its separate key settings/)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'How this works' }));
    expect(
      screen.getByText(
        'Mode changes apply to new work. Started runs keep their selected connection.',
      ),
    ).toBeInTheDocument();
    expect(screen.getByText('Kiro uses its separate key settings.')).toBeInTheDocument();
  });

  it('drafts a platform connection through the provider Setup and applies it after review', async () => {
    const user = userEvent.setup();
    const onApplied = vi.fn(async () => {});
    renderSettings({
      authentication: view({
        policy: { mode: 'keys', revision: 3, defaultConnectionId: 'keys-platform-default' },
        connection: { ...platformConnection, mode: 'keys', mechanism: 'api-key' },
      }),
      onApplied,
    });

    // The active mode is never offered as a change, even with a served default.
    expect(screen.queryByRole('button', { name: 'Review mode change' })).not.toBeInTheDocument();
    await pickMode(user, 'Test gateway');
    await user.click(screen.getByRole('button', { name: 'Set up Test gateway connection' }));
    expect(screen.getByText('Setup for platform without space')).toBeInTheDocument();
    expect(screen.getByText('Initial: null')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit draft' }));

    expect(preview).toHaveBeenCalledWith({
      kind: 'connection-draft',
      mode: 'test-connection',
      configuration: { endpoint: 'https://next.example' },
    });
    expect(
      await screen.findByText('Agents will use this test link, unless a space has its own.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Test setup' })).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Confirm change' }));
    await waitFor(() => expect(apply).toHaveBeenCalledWith('review-1'));
    expect(onApplied).toHaveBeenCalledOnce();
  });

  it('opens Setup with the active connection and keeps it open when the draft is refused', async () => {
    const user = userEvent.setup();
    const refusal = new Error('Connection configuration contains unsupported fields');
    preview.mockRejectedValueOnce(refusal);
    renderSettings();

    await user.click(screen.getByRole('button', { name: 'Change Test gateway connection' }));
    expect(
      screen.getByText('Initial: {"endpoint":"https://platform.example"}'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit draft' }));

    await waitFor(() => expect(setupFailure).toHaveBeenCalledWith(refusal));
    expect(screen.getByRole('dialog', { name: 'Test setup' })).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it("switches to keys through the mode's served default connection", async () => {
    const user = userEvent.setup();
    renderSettings();

    await pickMode(user, 'Keys');
    await user.click(screen.getByRole('button', { name: 'Review mode change' }));

    expect(preview).toHaveBeenCalledWith({
      mode: 'keys',
      defaultConnectionId: 'keys-platform-default',
    });
    expect(await screen.findByText('Agents will switch to Keys.')).toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
  });

  it('offers no switch when an older backend serves no default connection', async () => {
    const user = userEvent.setup();
    renderSettings({
      authentication: view({
        modes: [
          { id: 'keys', label: 'Keys', available: true },
          { id: 'test-connection', label: 'Test gateway', available: true },
        ],
      }),
    });

    await pickMode(user, 'Keys');

    expect(screen.queryByRole('button', { name: 'Review mode change' })).not.toBeInTheDocument();
    expect(screen.getByText(/Keys needs a ready platform connection/)).toBeInTheDocument();
    expect(preview).not.toHaveBeenCalled();
  });

  it('renders a mode without a registered UI read-only with the generic summary', async () => {
    const user = userEvent.setup();
    const plainConnection: AgentConnectionView = {
      ...platformConnection,
      id: 'plain-platform',
      mode: 'plain-mode',
      configuration: { endpoint: 'https://plain.example', scopes: ['models'], port: 443 },
    };
    const plain = view({
      policy: { mode: 'plain-mode', revision: 3, defaultConnectionId: 'plain-platform' },
      connection: plainConnection,
    });
    const platform = renderSettings({ authentication: plain });

    expect(screen.getByText('Endpoint: https://plain.example')).toBeInTheDocument();
    expect(screen.queryByText(/Scopes|Port/)).not.toBeInTheDocument();
    expect(actionButtons()).toHaveLength(0);
    expect(screen.queryByText(/needs a ready platform connection/)).not.toBeInTheDocument();
    platform.unmount();

    const space = renderSettings({ authentication: plain, scope: 'space', projectId: 'p1' });
    expect(screen.getByText('Platform mode: Plain')).toBeInTheDocument();
    expect(screen.getByText('Endpoint: https://plain.example')).toBeInTheDocument();
    expect(actionButtons()).toHaveLength(0);
    expect(screen.queryByText(/Only platform administrators/)).not.toBeInTheDocument();
    space.unmount();

    renderSettings();
    await pickMode(user, 'Plain');
    expect(actionButtons()).toHaveLength(0);
    expect(screen.getByText(/Plain needs a ready platform connection/)).toBeInTheDocument();
  });

  it('drafts a space connection for the space with the provider noun', async () => {
    const user = userEvent.setup();
    renderSettings({ scope: 'space', projectId: 'p1' });

    expect(screen.getByText(/Inherits platform connection/)).toBeInTheDocument();
    expect(screen.getByText('Gateway: https://platform.example')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Use platform connection' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Set space test link' }));
    expect(screen.getByText('Setup for space p1')).toBeInTheDocument();
    expect(screen.getByText('Initial: null')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit draft' }));

    expect(preview).toHaveBeenCalledWith({
      kind: 'connection-draft',
      mode: 'test-connection',
      projectId: 'p1',
      configuration: { endpoint: 'https://next.example' },
    });
    expect(
      await screen.findByText('Agents in this space will use this test link.'),
    ).toBeInTheDocument();
  });

  it('restores platform inheritance for a space override', async () => {
    const user = userEvent.setup();
    renderSettings({
      authentication: view({ connection: spaceConnection }),
      scope: 'space',
      projectId: 'p1',
      hasOverride: true,
    });

    expect(screen.getByText(/Space test link override/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change space test link' }));
    expect(screen.getByText('Initial: {"endpoint":"https://space.example"}')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close setup' }));
    await user.click(screen.getByRole('button', { name: 'Use platform connection' }));

    expect(preview).toHaveBeenCalledWith({
      kind: 'space-selection',
      projectId: 'p1',
      connectionId: null,
    });
    expect(
      await screen.findByText('Agents in this space will use the platform connection again.'),
    ).toBeInTheDocument();
  });

  it('keeps space connections with platform administrators', () => {
    renderSettings({
      authentication: view({ canManageConnections: false, connection: spaceConnection }),
      scope: 'space',
      projectId: 'p1',
      hasOverride: true,
    });

    expect(actionButtons()).toHaveLength(0);
    expect(
      screen.getByText('Only platform administrators can configure space connections.'),
    ).toBeInTheDocument();
  });

  it('shows people the platform default Bedrock access, read-only, and that a space may differ', () => {
    renderSettings({ scope: 'personal' });
    const access = screen.getByRole('region', { name: 'Platform default Bedrock access' });
    expect(access).toHaveTextContent('Platform default Bedrock access: Test gateway');
    expect(access).toHaveTextContent('A space can use its own access instead.');
    expect(access).toHaveTextContent('Status: Ready');
    expect(access).toHaveTextContent('Gateway: https://platform.example');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
    expect(screen.queryByText(/Platform mode/)).not.toBeInTheDocument();
  });

  it('tells people when the shared connection needs an administrator', () => {
    renderSettings({
      scope: 'personal',
      authentication: view({
        connection: { ...platformConnection, state: 'reconnect-required' },
      }),
    });
    expect(screen.getByText('Status: Needs reconnecting by an administrator')).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'An administrator must reconnect the platform default before agents that use it can start.',
    );
    expect(screen.getByText('Gateway: https://platform.example')).toBeInTheDocument();
  });

  it('keeps Keys mode short for people and only speaks up when no key is available', () => {
    const keys = (state: string) =>
      view({
        policy: { mode: 'keys', revision: 3, defaultConnectionId: 'keys-platform-default' },
        personalMechanisms: ['api-key'],
        connection: { ...platformConnection, mode: 'keys', mechanism: 'api-key', state },
      });
    const { container, unmount } = renderSettings({
      scope: 'personal',
      authentication: keys('ready'),
    });
    expect(container).toBeEmptyDOMElement();
    unmount();

    renderSettings({ scope: 'personal', authentication: keys('missing') });
    expect(screen.getByRole('status')).toHaveTextContent(
      "There is no platform Bedrock key. Agents use a space's key where one is set; otherwise add your own key below or ask an administrator.",
    );
  });

  it('names the connection backend and state for people, never as raw enums', () => {
    const { unmount } = renderSettings();
    expect(screen.getByText('Connection: Amazon Bedrock · Ready')).toBeInTheDocument();
    expect(screen.queryByText(/bedrock · ready/)).not.toBeInTheDocument();
    unmount();

    renderSettings({
      authentication: view({ connection: { ...platformConnection, state: 'reconnect-required' } }),
    });
    expect(
      screen.getByText('Connection: Amazon Bedrock · Needs reconnecting by an administrator'),
    ).toBeInTheDocument();
  });
});
