import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const defaults = vi.fn();
const generate = vi.fn();
const verify = vi.fn();
vi.mock('@/services/agents', () => ({
  agentsService: {
    getBedrockIamDefaults: (...args: unknown[]) => defaults(...args),
    generateBedrockIamSetup: (...args: unknown[]) => generate(...args),
    verifyBedrockIam: (...args: unknown[]) => verify(...args),
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
    const onSave = vi.fn().mockResolvedValue(undefined);
    const onClose = vi.fn();
    render(<BedrockIamWizard onSave={onSave} onClose={onClose} />);
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
    expect(onSave).not.toHaveBeenCalled();
    expect(screen.getByText('# application account commands')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Continue to test' }));
    expect(screen.getByRole('button', { name: 'Enable platform IAM' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    await screen.findByRole('status');
    await user.click(screen.getByRole('button', { name: 'Enable platform IAM' }));
    await waitFor(() => expect(onSave).toHaveBeenCalledWith(config));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('keeps activation disabled after a failed check and retains the space scope on retries', async () => {
    const user = userEvent.setup();
    verify.mockResolvedValueOnce({
      verified: false,
      error: 'The role trust policy does not allow this runtime',
    });
    const onSave = vi.fn();
    render(
      <BedrockIamWizard projectId="space-one" initial={config} onSave={onSave} onClose={vi.fn()} />,
    );
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Generate AWS setup' })).toBeEnabled(),
    );
    await user.click(screen.getByRole('button', { name: 'Generate AWS setup' }));
    await user.click(await screen.findByRole('button', { name: 'Continue to test' }));
    await user.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('trust policy');
    expect(screen.getByRole('button', { name: 'Use this role for new runs' })).toBeDisabled();
    expect(verify).toHaveBeenCalledWith(config, 'space-one');
    expect(onSave).not.toHaveBeenCalled();
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Back' }));
    await user.click(screen.getByRole('button', { name: 'Generate AWS setup' }));
    await user.click(await screen.findByRole('button', { name: 'Continue to test' }));
    expect(screen.getByRole('button', { name: 'Use this role for new runs' })).toBeDisabled();
  });
});
