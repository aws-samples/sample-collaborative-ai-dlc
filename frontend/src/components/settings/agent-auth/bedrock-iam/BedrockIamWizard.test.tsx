import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const defaults = vi.fn();
const generate = vi.fn();
const verify = vi.fn();
// Every IAM step goes through the generic setup route; each action keeps its own
// mock, called with (config, projectId) as the #488 service methods were.
vi.mock('@/services/agents', () => ({
  agentsService: {
    authenticationProviderAction: (
      mode: string,
      action: string,
      { config, projectId }: { config?: unknown; projectId?: string },
    ) => {
      if (mode !== 'iam') throw new Error(`Unexpected authentication mode ${mode}`);
      if (action === 'defaults') return defaults(projectId);
      if (action === 'setup') return generate(config, projectId);
      if (action === 'verify') return verify(config, projectId);
      throw new Error(`Unexpected IAM setup action ${action}`);
    },
  },
}));

import { BedrockIamWizard } from './BedrockIamWizard';

const config = { roleArn: 'arn:aws:iam::222222222222:role/Inference', region: 'eu-west-1' };
const setup = {
  config,
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

beforeEach(() => {
  vi.resetAllMocks();
  defaults.mockResolvedValue({ brokerRoleArn: setup.brokerRoleArn, region: 'us-east-1' });
  generate.mockResolvedValue(setup);
  verify.mockResolvedValue({ verified: true, models: [{ id: 'eu.anthropic.claude-sonnet-4-6' }] });
});

describe('Bedrock IAM wizard', () => {
  it('generates configuration for a different account and requires verification before activation', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<BedrockIamWizard scope="platform" onSubmit={onSubmit} onClose={onClose} />);
    const account = screen.getByLabelText('Inference AWS account');
    await waitFor(() => expect(account).toHaveValue('111111111111'));
    await user.clear(account);
    await user.type(account, '222222222222');
    const region = screen.getByLabelText('Bedrock region');
    await user.clear(region);
    await user.type(region, 'eu-west-1');
    const role = screen.getByLabelText('Inference role name or path');
    await user.clear(role);
    await user.type(role, 'Inference');
    await user.click(screen.getByRole('button', { name: 'Generate AWS setup' }));
    await screen.findByText('# inference account commands');
    expect(generate).toHaveBeenCalledWith(config, undefined);
    expect(onSubmit).not.toHaveBeenCalled();
    expect(screen.getByText('# application account commands')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to test' }));
    expect(screen.getByRole('button', { name: 'Review connection change' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Review connection change' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(config));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('tests an existing role before showing any setup commands', async () => {
    const user = userEvent.setup();
    const onSubmit = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<BedrockIamWizard scope="platform" onSubmit={onSubmit} onClose={onClose} />);
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Generate AWS setup' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('checkbox', { name: 'I already have an inference role' }));
    await user.click(screen.getByRole('button', { name: 'Continue to connection test' }));

    await screen.findByRole('button', { name: 'Test connection' });
    expect(
      within(screen.getByRole('list', { name: 'Setup progress' })).getAllByRole('listitem'),
    ).toHaveLength(2);
    expect(screen.queryByText('# inference account commands')).not.toBeInTheDocument();
    expect(screen.queryByText('# application account commands')).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Connect this deployment to the role' }),
    ).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByRole('button', { name: 'Review connection change' })).toBeDisabled();
    expect(verify).not.toHaveBeenCalled();

    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByRole('status');
    expect(verify).toHaveBeenCalledWith(config, undefined);
    expect(screen.queryByText('# application account commands')).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Review connection change' }));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(config));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps activation disabled after a failed check and retains the space scope on retries', async () => {
    const user = userEvent.setup();
    verify.mockResolvedValueOnce({
      verified: false,
      error: 'The role trust policy does not allow this runtime',
    });
    const onSubmit = vi.fn();
    render(
      <BedrockIamWizard
        scope="space"
        projectId="space-one"
        initial={config}
        onSubmit={onSubmit}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue to connection test' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Continue to connection test' }));
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('trust policy');
    const help = screen.getByRole('region', { name: 'Existing role permission help' });
    expect(within(help).getByText('# application account commands')).toBeVisible();
    expect(within(help).getByText('# reuse role commands')).toBeVisible();
    expect(within(help).getByText(/keeps the role's existing trust and policies/)).toBeVisible();
    expect(screen.queryByText('# inference account commands')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Review connection change' })).toBeDisabled();
    expect(verify).toHaveBeenCalledWith(config, 'space-one');
    expect(onSubmit).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Continue to connection test' }));
    expect(await screen.findByRole('button', { name: 'Review connection change' })).toBeDisabled();
    expect(
      screen.queryByRole('region', { name: 'Existing role permission help' }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByRole('status');
    expect(verify).toHaveBeenLastCalledWith(config, 'space-one');
    expect(screen.getByRole('button', { name: 'Review connection change' })).toBeEnabled();
  });

  it('offers a single reusable setup command when both deployments share the inference account', async () => {
    const user = userEvent.setup();
    generate.mockResolvedValue({
      ...setup,
      applicationAccountId: setup.inferenceAccountId,
      brokerRoleArn: 'arn:aws:iam::222222222222:role/review-broker',
    });
    render(
      <BedrockIamWizard scope="platform" initial={config} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue to connection test' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Continue to connection test' }));
    await user.click(
      await screen.findByRole('button', { name: 'Connect this deployment to the role' }),
    );
    expect(screen.getByText('# reuse role commands')).toBeVisible();
    expect(screen.queryByText('# application account commands')).not.toBeInTheDocument();
    expect(screen.queryByText('# inference account commands')).not.toBeInTheDocument();
    expect(
      screen.getByText(/includes both the role trust and application access setup/),
    ).toBeVisible();
    expect(screen.getByText(/arn:aws:iam::222222222222:role\/review-broker/)).toBeVisible();
    expect(verify).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Review connection change' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Copy Connect this deployment/ }));
    expect(await navigator.clipboard.readText()).toBe(setup.reuseCommands);
  });

  it('keeps the ExternalId and stays open with the error when the draft is refused', async () => {
    const user = userEvent.setup();
    const withExternalId = { ...config, externalId: 'external-fixture' };
    generate.mockResolvedValue({ ...setup, config: withExternalId });
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error('Configuration changed; review again.'))
      .mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(
      <BedrockIamWizard
        scope="platform"
        initial={withExternalId}
        onSubmit={onSubmit}
        onClose={onClose}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Continue to connection test' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Continue to connection test' }));
    expect(generate).toHaveBeenCalledWith(withExternalId, undefined);
    await user.click(await screen.findByRole('button', { name: 'Test connection' }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Review connection change' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Configuration changed');
    expect(onClose).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Review connection change' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledOnce());
    expect(onSubmit).toHaveBeenLastCalledWith(withExternalId);
  });

  it('starts a fresh setup when the served configuration is not an IAM role', async () => {
    render(
      <BedrockIamWizard
        scope="platform"
        initial={{ endpoint: 'https://gateway.example', region: 'eu-west-1' }}
        onSubmit={vi.fn()}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() => expect(screen.getByLabelText('Bedrock region')).toHaveValue('us-east-1'));
    expect(screen.getByLabelText('Inference AWS account')).toHaveValue('111111111111');
    expect(screen.getByLabelText('Inference role name or path')).toHaveValue(
      'CollaborativeBedrock-Platform',
    );
    expect(
      screen.getByRole('checkbox', { name: 'I already have an inference role' }),
    ).not.toBeChecked();
  });
});
