import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
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

const SPACE_A_STATUS = {
  bedrockBearerTokenSet: true,
  kiroApiKeySet: false,
  // A bearer-configured space, so its card opens on the bearer method.
  bedrockMode: 'bearer',
  platformFallback: {
    bedrockBearerTokenSet: true,
    kiroApiKeySet: false,
  },
};

const SPACE_B_STATUS = {
  bedrockBearerTokenSet: false,
  kiroApiKeySet: true,
  // No Bedrock binding at all, so its card opens on the recommended method.
  bedrockMode: null,
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

    const bedrockMethod = await screen.findByLabelText('IAM role');
    const kiro = screen.getByLabelText(/Kiro API Key/);
    // space-b has no Bedrock binding, so its card opens on the recommended method.
    expect(bedrockMethod).toBeChecked();
    expect(kiro).toHaveAttribute('placeholder', 'Enter a new key to rotate, or leave blank');

    await act(async () => {
      lateSpaceA.resolve(SPACE_A_STATUS);
      await lateSpaceA.promise;
    });

    // A late space-a response must not flip the method to bearer or restyle Kiro.
    expect(bedrockMethod).toBeChecked();
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

// specs/bedrock-iam-role-credential-mode — req-configured-semantics,
// req-bearer-deprecated, req-external-id-lifecycle, req-binding-preflight.
describe('AgentCredentialScopeCard bedrock role mode', () => {
  const ROLE_ARN = 'arn:aws:iam::444455556666:role/aidlc-bedrock-inference';

  it('reports a role-only scope as configured, with no secret stored', async () => {
    // The load-bearing case: this scope has NO bedrock secret at all, so a card
    // deriving "configured" from a secret would render it as having no credentials.
    getProjectCredentials.mockResolvedValue({
      bedrockBearerTokenSet: false,
      kiroApiKeySet: false,
      bedrockMode: 'role',
      bedrockRoleArn: ROLE_ARN,
      bedrockExternalIdSet: false,
      platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
    });

    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);

    expect(await screen.findByText('1 provider configured')).toBeInTheDocument();
    expect(screen.getByText(ROLE_ARN)).toBeInTheDocument();
    expect(screen.getByText('Recommended')).toBeInTheDocument();
    // The bearer method is still offered, marked deprecated, so existing bearer
    // deployments keep working — but its input is not rendered while role is chosen.
    expect(screen.getByText('Deprecated')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Bearer token value/)).not.toBeInTheDocument();
  });

  it('starts on the method the scope already uses and shows only its input', async () => {
    getProjectCredentials.mockResolvedValue({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
      bedrockMode: 'bearer',
      platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
    });

    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);

    // The form must describe the STORED state rather than the recommended default.
    expect(await screen.findByLabelText('Bearer token')).toBeChecked();
    expect(screen.getByLabelText(/Bearer token value/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Role ARN')).not.toBeInTheDocument();
  });

  it('warns that switching method replaces the stored binding', async () => {
    // One SSM parameter holds the Bedrock value, so this is a replacement rather
    // than an addition — said plainly rather than discovered after saving.
    getProjectCredentials.mockResolvedValue({
      bedrockBearerTokenSet: true,
      kiroApiKeySet: false,
      bedrockMode: 'bearer',
      platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
    });

    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);
    await userEvent.setup().click(await screen.findByLabelText('IAM role'));

    expect(screen.getByText(/Saving replaces the bearer token/)).toBeInTheDocument();
  });

  it('sends only the role ARN, never an external ID', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);

    await user.type(await screen.findByLabelText('Role ARN'), ROLE_ARN);
    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));

    // The role travels in the same field as a bearer token — which shape the value
    // holds is a property of the value. The external ID is the server's to generate.
    await waitFor(() =>
      expect(updateProjectCredentials).toHaveBeenCalledWith('p-1', {
        bedrockBearerToken: JSON.stringify({ roleArn: ROLE_ARN }),
      }),
    );
  });

  it('shows a returned external ID masked behind a collapsed reference section', async () => {
    const user = userEvent.setup();
    updateProjectCredentials.mockResolvedValue({
      saved: true,
      bedrockRoleArn: ROLE_ARN,
      bedrockExternalId: 'generated-external-id',
    });

    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);
    await user.type(await screen.findByLabelText('Role ARN'), ROLE_ARN);
    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));

    // Read-only reference values stay collapsed so they do not crowd the inputs.
    const toggle = await screen.findByTestId('space-trust-details-toggle');
    expect(screen.queryByTestId('space-bedrock-external-id-value')).not.toBeInTheDocument();
    await user.click(toggle);

    const value = await screen.findByTestId('space-bedrock-external-id-value');
    // Masked by default — presentation hygiene, not a security control, since AWS
    // states the value is not a secret.
    expect(value).not.toHaveTextContent('generated-external-id');
    await user.click(screen.getByRole('button', { name: /Reveal External ID/ }));
    expect(await screen.findByText('generated-external-id')).toBeInTheDocument();
  });

  it('keeps the external ID visible when the preflight rejects the save', async () => {
    const user = userEvent.setup();
    const { ApiError } = await import('@/services/api');
    updateProjectCredentials.mockRejectedValue(
      new ApiError(400, 'The Bedrock role could not be assumed with this binding', {
        code: 'BEDROCK_ROLE_PREFLIGHT_FAILED',
        preflight: {
          cause: 'trust-policy-rejected',
          candidates: [{ candidate: 'principal-not-trusted', detail: 'Trust the broker role.' }],
        },
        bedrockExternalId: 'value-to-paste',
      }),
    );

    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);
    await user.type(await screen.findByLabelText('Role ARN'), ROLE_ARN);
    await user.click(screen.getByRole('button', { name: 'Save Credentials' }));

    // This is the bootstrap: the operator cannot write the trust policy the
    // preflight is checking until they have the value, so a rejection surfaces both
    // the reason and the value — and OPENS the reference section, because that is
    // exactly the moment those values are needed.
    expect(await screen.findByText(/trust-policy-rejected/)).toBeInTheDocument();
    expect(screen.getByText('Trust the broker role.')).toBeInTheDocument();
    expect(screen.getByTestId('space-bedrock-external-id-value')).toBeInTheDocument();
  });

  it('surfaces the broker principal an operator must trust', async () => {
    getProjectCredentials.mockResolvedValue({
      bedrockBearerTokenSet: false,
      kiroApiKeySet: false,
      bedrockMode: 'role',
      bedrockRoleArn: ROLE_ARN,
      bedrockBrokerRoleArn: 'arn:aws:iam::111122223333:role/collab-credential-broker-dev',
      platformFallback: { bedrockBearerTokenSet: false, kiroApiKeySet: false },
    });

    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);

    // Without this the operator cannot write the trust policy at all, so it is shown
    // rather than documented (req-same-and-cross-account). It is identical for every
    // tenant, so it is NOT masked — masking it would be friction with no benefit.
    await userEvent.setup().click(await screen.findByTestId('space-trust-details-toggle'));
    expect(
      await screen.findByText('arn:aws:iam::111122223333:role/collab-credential-broker-dev'),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Reveal Principal to trust/ }),
    ).not.toBeInTheDocument();
  });

  it('offers exactly one Bedrock input at a time', async () => {
    const user = userEvent.setup();
    render(<AgentCredentialScopeCard scope="space" projectId="p-1" />);

    // A scope stores ONE Bedrock value in one parameter, so the radio makes the two
    // methods mutually exclusive by construction rather than by validation.
    expect(await screen.findByLabelText('Role ARN')).toBeInTheDocument();
    expect(screen.queryByLabelText(/Bearer token value/)).not.toBeInTheDocument();

    await user.click(screen.getByLabelText('IAM role'));
    expect(screen.getByLabelText('Role ARN')).toBeInTheDocument();

    await user.click(screen.getByLabelText('Bearer token'));
    expect(screen.queryByLabelText('Role ARN')).not.toBeInTheDocument();
  });

  it('offers no role method at personal scope, but still marks the token deprecated', async () => {
    render(<AgentCredentialScopeCard scope="personal" />);
    // That endpoint is gated only on authentication, so any member could otherwise
    // name a role ARN (dec-user-scope-role-deferred) — hence no radio here.
    expect(await screen.findByLabelText(/Bedrock Bearer Token \(deprecated\)/)).toBeInTheDocument();
    expect(screen.queryByLabelText('IAM role')).not.toBeInTheDocument();
    // req-bearer-deprecated applies to every card. Naming WHERE the alternative
    // lives is what makes it actionable for a user who cannot choose a role here.
    expect(screen.getByText(/configured at space or platform scope/)).toBeInTheDocument();
  });
});
