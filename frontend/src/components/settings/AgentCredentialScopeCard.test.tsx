import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

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

import { AgentCredentialScopeCard } from './AgentCredentialScopeCard';

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
});
