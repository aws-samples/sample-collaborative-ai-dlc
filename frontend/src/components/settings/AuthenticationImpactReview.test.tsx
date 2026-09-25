import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { AgentAuthenticationModeSettings } from './AgentAuthenticationModeSettings';
import { AgentCredentialScopeCard } from './AgentCredentialScopeCard';
import { AuthenticationImpactReview } from './AuthenticationImpactReview';
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
    expect(screen.getByText('Gateway: https://gateway.example')).toBeInTheDocument();
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();
  });
  it('shows evidence limits and requires an explicit apply click', async () => {
    const onApply = vi.fn();
    render(
      <AuthenticationImpactReview
        review={review}
        applying={false}
        onApply={onApply}
        onCancel={vi.fn()}
      />,
    );
    expect(screen.getByText(/Older runtime sessions/)).toBeInTheDocument();
    expect(screen.getByText(/Next invocation or renewal loses access: 1/)).toBeInTheDocument();
    expect(onApply).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Apply reviewed change' }));
    expect(onApply).toHaveBeenCalledOnce();
  });
  it('previews a key replacement and only writes after administrator activation', async () => {
    render(<AgentCredentialScopeCard scope="platform" />);
    const field = await screen.findByLabelText(/Bedrock Bearer Token/);
    await userEvent.type(field, 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    expect(
      await screen.findByRole('region', { name: 'Authentication change impact' }),
    ).toBeInTheDocument();
    expect(agentsService.updateSettings).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Apply reviewed change' }));
    await waitFor(() =>
      expect(agentsService.updateSettings).toHaveBeenCalledWith({
        bedrockBearerToken: 'replacement-key',
        reviewId: 'review-1',
      }),
    );
  });
  it('discards a stale preview and permits review of the entered key again', async () => {
    vi.mocked(agentsService.updateSettings).mockRejectedValueOnce(
      Object.assign(new Error('Work changed; review again'), { code: 'AGENT_AUTH_REVIEW_STALE' }),
    );
    render(<AgentCredentialScopeCard scope="platform" />);
    await userEvent.type(await screen.findByLabelText(/Bedrock Bearer Token/), 'replacement-key');
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Apply reviewed change' }));
    await waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Apply reviewed change' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.getByText('Work changed; review again')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Save Credentials' }));
    expect(
      await screen.findByRole('button', { name: 'Apply reviewed change' }),
    ).toBeInTheDocument();
  });
});
