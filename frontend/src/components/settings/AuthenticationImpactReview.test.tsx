import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentAuthenticationModeSettings } from './AgentAuthenticationModeSettings';
import { AgentCredentialScopeCard } from './AgentCredentialScopeCard';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';
import { genericSummary } from './agent-auth/summary';
import { reviewHasNoImpact } from './agent-auth/impact';
import { ApiError } from '@/services/api';
import type { AgentAuthProviderUi } from './agent-auth/contract';
import {
  agentsService,
  type AgentAuthenticationView,
  type AgentAuthImpactReview,
} from '@/services/agents';

vi.mock('@/services/agents', () => ({
  agentsService: {
    getSettings: vi.fn(),
    updateSettings: vi.fn(),
    getProjectCredentials: vi.fn(),
    updateProjectCredentials: vi.fn(),
    getPersonalCredentials: vi.fn(),
    updatePersonalCredentials: vi.fn(),
    previewCredentialUpdate: vi.fn(),
    previewAuthenticationChange: vi.fn(),
    applyAuthenticationChange: vi.fn(),
  },
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => ({ projects: [{ project: { id: 'p1', name: 'Payments' } }] }),
}));
vi.mock('./agent-auth/registry', () => {
  const ui: AgentAuthProviderUi = {
    mode: 'test-connection',
    noun: 'test link',
    Setup: () => null,
    summarize: (configuration) => [{ label: 'Gateway', value: String(configuration.endpoint) }],
  };
  return {
    AGENT_AUTH_PROVIDER_UIS: [ui],
    agentAuthProviderUi: (mode?: string | null) => (mode === ui.mode ? ui : undefined),
  };
});
const authentication: AgentAuthenticationView = {
  policy: { mode: 'keys', revision: 0, defaultConnectionId: 'legacy-platform-bedrock' },
  modes: [
    { id: 'keys', label: 'Keys', available: true },
    { id: 'iam', label: 'IAM', available: false },
    { id: 'litellm', label: 'LiteLLM', available: false },
  ],
  reviewRequired: true,
  personalMechanisms: ['api-key'],
  connection: {
    id: 'legacy-platform-bedrock',
    mode: 'keys',
    backend: 'bedrock',
    mechanism: 'api-key',
    source: 'platform',
    state: 'ready',
    configuration: {},
  },
};
const review: AgentAuthImpactReview = {
  id: 'review-1',
  createdAt: '2026-09-24T08:00:00Z',
  policyRevision: 0,
  complete: false,
  limitations: ['Older runtime sessions do not provide complete invocation accounting.'],
  counts: { continues: 0, 'loses-access': 1, unknown: 0 },
  items: [
    {
      key: 'EXEC#e1:META',
      id: 'e1',
      type: 'Execution',
      projectId: 'p1',
      status: 'WAITING',
      connectionId: 'legacy-platform-bedrock',
      outcome: 'loses-access',
      reason: 'The next invocation cannot acquire this credential.',
      action: 'Keep the credential while pinned work needs it.',
    },
  ],
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(agentsService.getSettings).mockResolvedValue({
    bedrockBearerTokenSet: true,
    kiroApiKeySet: false,
    authentication,
  });
  vi.mocked(agentsService.previewCredentialUpdate).mockResolvedValue(review);
  vi.mocked(agentsService.updateSettings).mockResolvedValue({ saved: true });
});

describe('authentication settings and impact review', () => {
  it('shows one enforced mode and disables providers that have not shipped', () => {
    render(
      <AgentAuthenticationModeSettings
        authentication={authentication}
        scope="platform"
        hasOverride={false}
        onApplied={vi.fn()}
      />,
    );
    expect(screen.getByLabelText('Agent authentication mode')).toHaveValue('keys');
    expect(screen.getByRole('option', { name: /IAM/ })).toBeDisabled();
    expect(screen.getByRole('option', { name: /LiteLLM/ })).toBeDisabled();
    expect(agentsService.applyAuthenticationChange).not.toHaveBeenCalled();
  });
  it('shows space inheritance and reconnect status without exposing secrets', () => {
    render(
      <AgentAuthenticationModeSettings
        authentication={{
          ...authentication,
          connection: {
            ...authentication.connection!,
            state: 'reconnect-required',
            configuration: { endpoint: 'https://gateway.example', issuer: 'https://idp.example' },
          },
        }}
        scope="space"
        hasOverride={false}
        onApplied={vi.fn()}
      />,
    );
    expect(screen.getByText(/Inherits platform connection/)).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent('administrator must reconnect');
    expect(screen.getByText('Endpoint: https://gateway.example')).toBeInTheDocument();
    expect(screen.getByText('Issuer: https://idp.example')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
});

const item = (
  outcome: string,
  overrides: Partial<AgentAuthImpactReview['items'][number]> = {},
): AgentAuthImpactReview['items'][number] => ({
  ...review.items[0],
  key: `${outcome}:${overrides.id ?? 'e1'}`,
  outcome,
  ...overrides,
});
const reviewWith = (...items: AgentAuthImpactReview['items']): AgentAuthImpactReview => ({
  ...review,
  candidate: {
    kind: 'credential-update',
    source: 'user',
    userId: 'u1',
    changes: [{ provider: 'bedrock', action: 'rotate', digest: 'a'.repeat(64) }],
  },
  counts: Object.fromEntries(
    ['continues', 'next-start', 'loses-access', 'repair', 'unknown'].map((outcome) => [
      outcome,
      items.filter((entry) => entry.outcome === outcome).length,
    ]),
  ),
  items,
});
const nextStartOnly = reviewWith(
  item('next-start', { id: 'scope', type: 'CredentialScope', projectId: null, status: null }),
);
const renderReview = (value: AgentAuthImpactReview, onApply = vi.fn()) =>
  render(
    <AuthenticationImpactReview
      review={value}
      applying={false}
      onApply={onApply}
      onCancel={vi.fn()}
    />,
  );
const JARGON =
  /Configuration revision|CredentialScope|invocation accounting|Activity \/ identity|Pinned work|Continues with existing identity|: 0/;

describe('plain impact confirmation', () => {
  it('says in one sentence what an unaffecting change does and offers one confirmation', () => {
    renderReview(nextStartOnly);
    const panel = screen.getByRole('region', { name: 'Confirm this change' });
    expect(panel).toHaveTextContent(
      'Your agent runs in every space will use this Bedrock API key.',
    );
    expect(panel).toHaveTextContent('This applies the next time an agent starts.');
    expect(panel).toHaveTextContent('Agents that are running now are not affected.');
    expect(panel).not.toHaveTextContent(JARGON);
    expect(screen.queryByText('Show details')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Confirm change' })).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Confirm this change' })).toHaveFocus();
  });

  it('notes work that keeps running without warning about it', () => {
    renderReview(reviewWith(item('continues', { status: 'RUNNING' })));
    expect(screen.getByRole('region', { name: 'Confirm this change' })).toHaveTextContent(
      '1 agent task that already started keeps working.',
    );
    expect(screen.queryByText(/not affected/)).not.toBeInTheDocument();
  });

  it('warns which started work loses access, what to do, and requires an explicit click', async () => {
    const onApply = vi.fn();
    renderReview(
      reviewWith(item('loses-access'), item('continues', { id: 'e2', status: 'RUNNING' })),
      onApply,
    );
    const panel = screen.getByRole('region', {
      name: 'Some work that already started may be affected',
    });
    expect(panel).toHaveTextContent(
      '1 agent task will lose access the next time it needs this key. To avoid this, keep the current key until it finishes.',
    );
    expect(panel).toHaveTextContent('1 agent task that already started keeps working.');
    expect(panel).not.toHaveTextContent(JARGON);
    expect(panel).not.toHaveTextContent(/e1|p1/);
    expect(screen.queryByText('Payments · Intent run (waiting)')).not.toBeInTheDocument();

    await userEvent.click(screen.getByText('Show details'));
    expect(await screen.findByText('Payments · Intent run (waiting)')).toBeInTheDocument();
    expect(screen.getByText('Will lose access')).toBeInTheDocument();
    expect(screen.getByText(/Older runtime sessions/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm anyway' }));
    expect(onApply).toHaveBeenCalledOnce();
  });

  it('says plainly when work could not be checked or needs reconnecting', () => {
    renderReview(
      reviewWith(
        item('unknown', { id: 'i1', type: 'AgentInvocation' }),
        item('unknown', { id: 'i2', type: 'AgentInvocation' }),
        item('repair', { id: 'e3', status: 'reconnect-required' }),
      ),
    );
    const panel = screen.getByRole('region', {
      name: 'Some work that already started may be affected',
    });
    expect(panel).toHaveTextContent(
      'We could not check whether 2 agent tasks will be affected. If they might still be running, wait until they finish before you continue.',
    );
    expect(panel).toHaveTextContent(
      '1 agent task cannot continue until its connection is reconnected. A platform administrator needs to reconnect it.',
    );
  });

  it('treats only next-start work as no impact, including outcomes it does not know', () => {
    expect(reviewHasNoImpact(nextStartOnly)).toBe(true);
    expect(reviewHasNoImpact({ ...nextStartOnly, items: [], counts: {} })).toBe(true);
    expect(reviewHasNoImpact(reviewWith(item('continues')))).toBe(false);
    expect(reviewHasNoImpact(reviewWith(item('unknown')))).toBe(false);
    expect(reviewHasNoImpact({ ...nextStartOnly, counts: { 'future-outcome': 1 } })).toBe(false);
    // A resumed review carries its counts without items.
    expect(reviewHasNoImpact({ ...nextStartOnly, items: [], counts: { repair: 1 } })).toBe(false);
  });
});

describe('saving keys through a review', () => {
  it('asks to confirm a key replacement that affects started work, then writes it', async () => {
    render(<AgentCredentialScopeCard scope="platform" />);
    const field = await screen.findByLabelText(/Bedrock Bearer Token/);
    await userEvent.type(field, 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    expect(
      await screen.findByRole('region', { name: 'Some work that already started may be affected' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save Credentials' })).not.toBeInTheDocument();
    expect(agentsService.updateSettings).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Confirm anyway' }));
    await waitFor(() =>
      expect(agentsService.updateSettings).toHaveBeenCalledWith({
        bedrockBearerToken: 'replacement-key',
        reviewId: 'review-1',
      }),
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      /^Agent runs will use this Bedrock API key, unless a person or space has set their own\./,
    );
  });

  it('cancels a confirmation without writing anything', async () => {
    render(<AgentCredentialScopeCard scope="platform" />);
    await userEvent.type(await screen.findByLabelText(/Bedrock Bearer Token/), 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Save Credentials' })).toBeEnabled();
    expect(agentsService.updateSettings).not.toHaveBeenCalled();
  });

  it('saves a personal key straight away when no started work is affected', async () => {
    vi.mocked(agentsService.getPersonalCredentials).mockResolvedValue({
      bedrockBearerTokenSet: false,
      kiroApiKeySet: false,
      authentication: { ...authentication, hasOverride: false },
    });
    vi.mocked(agentsService.previewCredentialUpdate).mockResolvedValue({
      ...nextStartOnly,
      id: 'review-safe',
    });
    vi.mocked(agentsService.updatePersonalCredentials).mockResolvedValue({ saved: true });
    render(<AgentCredentialScopeCard scope="personal" />);
    expect(await screen.findByText('Not set: shared keys are used')).toBeInTheDocument();
    expect(screen.queryByText(/Platform mode|Kiro uses|Connection:/)).not.toBeInTheDocument();

    await userEvent.type(screen.getByLabelText(/Bedrock Bearer Token/), 'personal-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));

    await waitFor(() =>
      expect(agentsService.updatePersonalCredentials).toHaveBeenCalledWith({
        bedrockBearerToken: 'personal-key',
        reviewId: 'review-safe',
      }),
    );
    expect(agentsService.previewCredentialUpdate).toHaveBeenCalledWith('personal', undefined, {
      bedrockBearerToken: 'personal-key',
    });
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your agent runs in every space will use this Bedrock API key. This applies the next time an agent starts. Agents that are running now are not affected. You can change or remove keys here at any time.',
    );
  });

  it('asks before saving a personal key when started work could not be checked', async () => {
    vi.mocked(agentsService.getPersonalCredentials).mockResolvedValue({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
      authentication: { ...authentication, hasOverride: true },
    });
    vi.mocked(agentsService.previewCredentialUpdate).mockResolvedValue(
      reviewWith(item('unknown', { type: 'AgentInvocation' })),
    );
    render(<AgentCredentialScopeCard scope="personal" />);
    expect(await screen.findByText('Using your own Bedrock key')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear' }));

    expect(
      await screen.findByText(/We could not check whether 1 agent task will be affected/),
    ).toBeInTheDocument();
    expect(agentsService.previewCredentialUpdate).toHaveBeenCalledWith('personal', undefined, {
      bedrockBearerToken: '',
    });
    expect(agentsService.updatePersonalCredentials).not.toHaveBeenCalled();
  });

  it('reports a change that raced the automatic save in plain words and saves nothing', async () => {
    vi.mocked(agentsService.previewCredentialUpdate).mockResolvedValue(nextStartOnly);
    vi.mocked(agentsService.updateSettings).mockRejectedValueOnce(
      new ApiError(409, 'Work or configuration changed since review', {
        error: 'Work or configuration changed since review',
        code: 'AGENT_AUTH_REVIEW_STALE',
      }),
    );
    render(<AgentCredentialScopeCard scope="platform" />);
    await userEvent.type(await screen.findByLabelText(/Bedrock Bearer Token/), 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    expect(
      await screen.findByText(
        'Something changed while saving, so nothing was saved. Please try again.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region')).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Bedrock Bearer Token/)).toHaveValue('replacement-key');
  });

  it('discards a stale confirmation and permits saving the entered key again', async () => {
    vi.mocked(agentsService.updateSettings).mockRejectedValueOnce(
      new ApiError(409, 'Work changed; review again', {
        error: 'Work changed; review again',
        code: 'AGENT_AUTH_REVIEW_STALE',
      }),
    );
    render(<AgentCredentialScopeCard scope="platform" />);
    await userEvent.type(await screen.findByLabelText(/Bedrock Bearer Token/), 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm anyway' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Confirm anyway' })).not.toBeInTheDocument(),
    );
    expect(
      screen.getByText('Something changed while saving, so nothing was saved. Please try again.'),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    expect(await screen.findByRole('button', { name: 'Confirm anyway' })).toBeInTheDocument();
  });

  it('keeps a failed confirmation open and shows why', async () => {
    vi.mocked(agentsService.updateSettings).mockRejectedValueOnce(new Error('Network down'));
    render(<AgentCredentialScopeCard scope="platform" />);
    await userEvent.type(await screen.findByLabelText(/Bedrock Bearer Token/), 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Confirm anyway' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Network down');
    expect(screen.getByRole('button', { name: 'Confirm anyway' })).toBeEnabled();
  });
});

describe('reviewed candidate description', () => {
  const renderCandidate = (
    candidate: AgentAuthImpactReview['candidate'],
    modes = authentication.modes,
  ) =>
    render(
      <AuthenticationImpactReview
        review={{ ...review, candidate }}
        modes={modes}
        applying={false}
        onApply={vi.fn()}
        onCancel={vi.fn()}
      />,
    );
  const connection = {
    id: 'test-connection-1',
    revision: 1,
    mode: 'test-connection',
    backend: 'bedrock',
    mechanism: 'oauth-machine',
    source: 'space',
    projectId: 'p1',
    state: 'ready',
    configuration: { endpoint: 'https://gateway.example', audience: 'models' },
  };

  it('describes a proposed connection with the provider noun and summary', () => {
    renderCandidate({
      kind: 'connection-create',
      source: 'space',
      projectId: 'p1',
      select: true,
      connection,
    });
    expect(screen.getByText('Agents in this space will use this test link.')).toBeInTheDocument();
    expect(screen.getByText('Gateway: https://gateway.example')).toBeInTheDocument();
    expect(screen.queryByText(/Audience/)).not.toBeInTheDocument();
  });

  it('falls back to a generic noun and summary for modes without a UI', () => {
    renderCandidate({
      kind: 'connection-create',
      source: 'platform',
      select: true,
      connection: { ...connection, mode: 'plain-mode', source: 'platform' },
    });
    expect(
      screen.getByText('Agents will use this connection, unless a space has its own.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Endpoint: https://gateway.example')).toBeInTheDocument();
    expect(screen.getByText('Audience: models')).toBeInTheDocument();
  });

  it('describes a return to platform inheritance', () => {
    renderCandidate({
      kind: 'space-selection',
      source: 'space',
      projectId: 'p1',
      connectionId: null,
    });
    expect(
      screen.getByText('Agents in this space will use the platform connection again.'),
    ).toBeInTheDocument();
  });

  it('does not describe selecting a specific space connection as inheritance', () => {
    renderCandidate({
      kind: 'space-selection',
      source: 'space',
      projectId: 'p1',
      connectionId: 'test-platform',
    });
    expect(
      screen.queryByText('Agents in this space will use the platform connection again.'),
    ).not.toBeInTheDocument();
  });

  it('names the proposed mode by its label', () => {
    const candidate = {
      kind: 'policy-change',
      mode: 'keys',
      defaultConnectionId: 'legacy-platform-bedrock',
    } as const;
    const first = renderCandidate(candidate);
    expect(screen.getByText('Agents will switch to Keys.')).toBeInTheDocument();
    first.unmount();
    renderCandidate(candidate, []);
    expect(screen.getByText('Agents will switch to keys.')).toBeInTheDocument();
  });

  it('describes each key change for the scope that owns it', () => {
    const first = renderCandidate({
      kind: 'credential-update',
      source: 'space',
      projectId: 'p1',
      changes: [
        { provider: 'bedrock', action: 'rotate', digest: 'a'.repeat(64) },
        { provider: 'kiro', action: 'clear', digest: 'b'.repeat(64) },
      ],
    });
    expect(
      screen.getByText(
        'Agent runs in this space will use this Bedrock API key, unless a member has set their own.',
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Agent runs in this space will use members' own keys or the platform Kiro API key.",
      ),
    ).toBeInTheDocument();
    first.unmount();
    renderCandidate({
      kind: 'credential-update',
      source: 'user',
      userId: 'u1',
      changes: [{ provider: 'bedrock', action: 'clear', digest: 'a'.repeat(64) }],
    });
    expect(
      screen.getByText(
        'Your agent runs will use the space or platform Bedrock API key instead of yours.',
      ),
    ).toBeInTheDocument();
  });

  it('summarizes only non-empty string configuration fields with readable labels', () => {
    expect(
      genericSummary({
        endpoint: 'https://gateway.example',
        clientId: 'agents',
        token_url: 'https://idp.example/token',
        scopes: ['models'],
        port: 443,
        enabled: true,
        nested: { secret: 'hidden' },
        empty: '',
      }),
    ).toEqual([
      { label: 'Endpoint', value: 'https://gateway.example' },
      { label: 'Client id', value: 'agents' },
      { label: 'Token url', value: 'https://idp.example/token' },
    ]);
  });
});
