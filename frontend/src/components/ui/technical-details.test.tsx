import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { TechnicalDetails } from './technical-details';

const ARN = 'arn:aws:iam::123456789012:role/aidlc-codecommit-access-very-long-name';

describe('TechnicalDetails', () => {
  it('starts collapsed and reveals monospace full values on demand', async () => {
    const user = userEvent.setup();
    render(
      <TechnicalDetails
        items={[
          { label: 'Role ARN', value: ARN, copy: true },
          { label: 'Region', value: 'eu-west-1' },
        ]}
      />,
    );
    const trigger = screen.getByRole('button', { name: 'Technical details' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText(ARN)).not.toBeInTheDocument();

    await user.click(trigger);
    const value = screen.getByText(ARN);
    expect(value).toBeVisible();
    expect(screen.getByText('Region')).toBeVisible();
    expect(screen.getByText('eu-west-1')).toBeVisible();
  });

  it('copies the full value and announces it politely', async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText },
      configurable: true,
    });
    render(
      <TechnicalDetails
        title="Connection details"
        items={[
          { label: 'Role ARN', value: ARN, copy: true },
          { label: 'Region', value: 'eu-west-1' },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: 'Connection details' }));
    const copyButtons = screen.getAllByRole('button', { name: /Copy/ });
    expect(copyButtons).toHaveLength(1);
    expect(copyButtons[0]).toHaveAccessibleName('Copy Role ARN');

    await user.click(copyButtons[0]);
    expect(writeText).toHaveBeenCalledWith(ARN);
    const live = await screen.findByRole('status');
    expect(live).toHaveTextContent('Copied');
    expect(live).toHaveAttribute('aria-live', 'polite');
  });

  it('shows a dash for an empty value and never a copy button for it', async () => {
    const user = userEvent.setup();
    render(<TechnicalDetails items={[{ label: 'Secret ref', value: '', copy: true }]} />);
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(screen.getByText('—')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Copy/ })).not.toBeInTheDocument();
  });
});
