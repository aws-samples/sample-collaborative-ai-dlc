import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getConfig = vi.fn();
const updateConfig = vi.fn();
vi.mock('@/services/codecommit', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/services/codecommit')>();
  return {
    ...actual,
    codecommitAdminService: {
      getConfig: (...args: unknown[]) => getConfig(...args),
      updateConfig: (...args: unknown[]) => updateConfig(...args),
    },
  };
});

import { CodeCommitSourceControlCard } from './CodeCommitSourceControlCard';
import { ApiError } from '@/services/api';

const EXTERNAL_ID = 'aidlc:0f8fad5b-d9cb-469f-a165-70867728950e';
const ROLE = 'arn:aws:iam::123456789012:role/aidlc-codecommit';

const baseConfig = (overrides: Record<string, unknown> = {}) => ({
  principals: [
    'arn:aws:iam::999999999999:role/aidlc-credential-broker',
    'arn:aws:iam::999999999999:role/aidlc-source-control',
    'arn:aws:iam::999999999999:role/aidlc-codecommit',
  ],
  externalId: EXTERNAL_ID,
  trustPolicy: {
    Statement: [{ Condition: { StringEquals: { 'sts:ExternalId': EXTERNAL_ID } } }],
  },
  permissionsPolicy: {
    Statement: [
      { Sid: 'ListRepositoriesInAccount', Action: 'codecommit:ListRepositories', Resource: '*' },
    ],
  },
  roleArn: null,
  region: null,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  // Radix Select drives pointer-capture APIs jsdom does not implement.
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('CodeCommitSourceControlCard', () => {
  it('first setup: shows the form, the setup guide, and the external id — Not configured', async () => {
    getConfig.mockResolvedValue(baseConfig());
    render(<CodeCommitSourceControlCard />);

    expect(await screen.findByText('Not configured')).toBeInTheDocument();
    // Labeled fields for region and role ARN.
    expect(screen.getByLabelText('Role ARN')).toBeInTheDocument();
    expect(screen.getByLabelText('Repository region')).toBeInTheDocument();
    // Setup guide open by default on first setup, with the policies and the id.
    expect(screen.getByTestId('codecommit-trust-policy')).toHaveTextContent(EXTERNAL_ID);
    expect(screen.getByTestId('codecommit-permissions-policy')).toHaveTextContent(
      'ListRepositories',
    );
    expect(screen.getByText(EXTERNAL_ID)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Test & save' })).toBeInTheDocument();
  });

  it('Test & save sends role + region and shows the configured summary on success', async () => {
    getConfig.mockResolvedValue(baseConfig());
    updateConfig.mockResolvedValue(baseConfig({ roleArn: ROLE, region: 'us-east-1' }));
    const user = userEvent.setup();
    render(<CodeCommitSourceControlCard />);

    await screen.findByLabelText('Role ARN');
    await user.type(screen.getByLabelText('Role ARN'), ROLE);
    // Pick a region via the Radix select.
    await user.click(screen.getByLabelText('Repository region'));
    await user.click(await screen.findByRole('option', { name: 'us-east-1' }));
    await user.click(screen.getByRole('button', { name: 'Test & save' }));

    await waitFor(() =>
      expect(updateConfig).toHaveBeenCalledWith({ roleArn: ROLE, region: 'us-east-1' }),
    );
    // Configured summary: region + role, no edit form.
    expect(await screen.findByText('Connected in us-east-1.')).toBeInTheDocument();
    expect(screen.getByText(ROLE)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Change' })).toBeInTheDocument();
    expect(screen.queryByLabelText('Role ARN')).not.toBeInTheDocument();
  });

  it('trust error (424): shows "Nothing was saved" with the hint and ties it to the field', async () => {
    getConfig.mockResolvedValue(baseConfig());
    updateConfig.mockRejectedValue(
      new ApiError(424, 'Trust check failed', {
        error: 'The role refused the platform.',
        hint: 'Check the trust policy lists the 3 platform principals and this exact external ID.',
      }),
    );
    const user = userEvent.setup();
    render(<CodeCommitSourceControlCard />);

    await screen.findByLabelText('Role ARN');
    await user.type(screen.getByLabelText('Role ARN'), ROLE);
    await user.click(screen.getByLabelText('Repository region'));
    await user.click(await screen.findByRole('option', { name: 'us-east-1' }));
    await user.click(screen.getByRole('button', { name: 'Test & save' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was saved.');
    expect(alert).toHaveTextContent('The role refused the platform.');
    expect(alert).toHaveTextContent(/exact external ID/i);
    // Nothing persisted: still editable, badge still "Not configured".
    expect(screen.getByLabelText('Role ARN')).toBeInTheDocument();
    expect(screen.getByText('Not configured')).toBeInTheDocument();
    // The invalid role field points at the error for assistive tech.
    const field = screen.getByLabelText('Role ARN');
    expect(field).toHaveAttribute('aria-invalid', 'true');
    expect(field.getAttribute('aria-describedby')).toBe(alert.id);
  });

  it('configured: starts collapsed to a summary and never shows the role ARN until expanded', async () => {
    getConfig.mockResolvedValue(baseConfig({ roleArn: ROLE, region: 'eu-west-1' }));
    render(<CodeCommitSourceControlCard />);

    expect(await screen.findByText('Configured')).toBeInTheDocument();
    expect(screen.getByText('Connected in eu-west-1.')).toBeInTheDocument();
    expect(screen.getByText(ROLE)).toBeInTheDocument();
    // The setup guide is collapsed, so the trust policy is not shown yet.
    expect(screen.queryByTestId('codecommit-trust-policy')).not.toBeInTheDocument();
  });

  it('a non-admin (403) sees an error, never the principals or external id', async () => {
    getConfig.mockRejectedValue(new ApiError(403, 'Platform admin required', {}));
    render(<CodeCommitSourceControlCard />);

    expect(await screen.findByText('Platform admin required')).toBeInTheDocument();
    expect(screen.queryByText(EXTERNAL_ID)).not.toBeInTheDocument();
    expect(screen.queryByText(/aidlc-credential-broker/)).not.toBeInTheDocument();
  });
});
