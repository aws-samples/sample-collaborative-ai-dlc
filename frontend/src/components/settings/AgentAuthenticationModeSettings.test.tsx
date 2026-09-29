import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
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

beforeEach(() => {
  vi.resetAllMocks();
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

    expect(screen.getByText(/Started runs keep their selected connection/)).toBeInTheDocument();
    // The active mode is never offered as a change, even with a served default.
    expect(screen.queryByRole('button', { name: 'Review mode change' })).not.toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'test-connection');
    await user.click(screen.getByRole('button', { name: 'Set up Test gateway connection' }));
    expect(screen.getByText('Setup for platform without space')).toBeInTheDocument();
    expect(screen.getByText('Initial: null')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Submit draft' }));

    expect(preview).toHaveBeenCalledWith({
      kind: 'connection-draft',
      mode: 'test-connection',
      configuration: { endpoint: 'https://next.example' },
    });
    expect(await screen.findByText('Proposed platform test link')).toBeInTheDocument();
    expect(screen.queryByRole('dialog', { name: 'Test setup' })).not.toBeInTheDocument();
    expect(apply).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Apply reviewed change' }));
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

    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'keys');
    await user.click(screen.getByRole('button', { name: 'Review mode change' }));

    expect(preview).toHaveBeenCalledWith({
      mode: 'keys',
      defaultConnectionId: 'keys-platform-default',
    });
    expect(await screen.findByText('Proposed mode: Keys')).toBeInTheDocument();
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

    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'keys');

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
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/needs a ready platform connection/)).not.toBeInTheDocument();
    platform.unmount();

    const space = renderSettings({ authentication: plain, scope: 'space', projectId: 'p1' });
    expect(screen.getByText('Platform mode: Plain')).toBeInTheDocument();
    expect(screen.getByText('Endpoint: https://plain.example')).toBeInTheDocument();
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(screen.queryByText(/Only platform administrators/)).not.toBeInTheDocument();
    space.unmount();

    renderSettings();
    await user.selectOptions(screen.getByLabelText('Agent authentication mode'), 'plain-mode');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
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
    expect(await screen.findByText('Proposed space test link')).toBeInTheDocument();
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
      await screen.findByText('Use the platform connection for new work in this space.'),
    ).toBeInTheDocument();
  });

  it('keeps space connections with platform administrators', () => {
    renderSettings({
      authentication: view({ canManageConnections: false, connection: spaceConnection }),
      scope: 'space',
      projectId: 'p1',
      hasOverride: true,
    });

    expect(screen.queryByRole('button')).not.toBeInTheDocument();
    expect(
      screen.getByText('Only platform administrators can configure space connections.'),
    ).toBeInTheDocument();
  });

  it('derives personal copy from the personal mechanisms and the mode label', () => {
    const { unmount } = renderSettings({ scope: 'personal' });
    expect(
      screen.getByText(/Personal overrides are unavailable while the platform uses Test gateway/),
    ).toBeInTheDocument();
    unmount();

    renderSettings({
      scope: 'personal',
      authentication: view({
        policy: { mode: 'keys', revision: 3, defaultConnectionId: 'keys-platform-default' },
        personalMechanisms: ['api-key'],
      }),
    });
    expect(screen.getByText(/Personal overrides use API keys\./)).toBeInTheDocument();
  });
});
