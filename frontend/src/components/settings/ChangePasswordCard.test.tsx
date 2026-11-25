import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';

const mocks = vi.hoisted(() => ({ changePassword: vi.fn() }));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ changePassword: mocks.changePassword }),
}));

import { ChangePasswordCard } from './ChangePasswordCard';

const fill = async (current: string, next: string, confirm: string) => {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Sign-in password' }));
  if (current) await user.type(screen.getByLabelText('Current password'), current);
  if (next) await user.type(screen.getByLabelText('New password'), next);
  if (confirm) await user.type(screen.getByLabelText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Change password' }));
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe('ChangePasswordCard', () => {
  it('starts collapsed with the form one action away', async () => {
    const user = userEvent.setup();
    render(<ChangePasswordCard />);

    const trigger = screen.getByRole('button', { name: 'Sign-in password' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByLabelText('Current password')).not.toBeInTheDocument();

    await user.click(trigger);
    expect(screen.getByLabelText('Current password')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Change password' })).toBeInTheDocument();
  });

  it('changes the password and clears the form', async () => {
    mocks.changePassword.mockResolvedValue(undefined);
    render(<ChangePasswordCard />);
    await fill('Old-password-1', 'New-password-1', 'New-password-1');

    expect(mocks.changePassword).toHaveBeenCalledWith('Old-password-1', 'New-password-1');
    expect(await screen.findByRole('status')).toHaveTextContent('Password changed.');
    expect(screen.getByLabelText('Current password')).toHaveValue('');
    expect(screen.getByLabelText('New password')).toHaveValue('');
  });

  it.each([
    ['', 'New-password-1', 'New-password-1', 'Enter your current password'],
    ['Old-password-1', 'New-password-1', 'New-password-2', 'New passwords do not match'],
    ['Same-password-1', 'Same-password-1', 'Same-password-1', 'must differ'],
    ['Old-password-1', 'nouppercase-1', 'nouppercase-1', 'uppercase'],
  ])('validates before calling Cognito (%s → %s)', async (current, next, confirm, message) => {
    render(<ChangePasswordCard />);
    await fill(current, next, confirm);

    expect(screen.getByRole('alert')).toHaveTextContent(message);
    expect(mocks.changePassword).not.toHaveBeenCalled();
  });

  it('shows the service error and keeps the entered values', async () => {
    mocks.changePassword.mockRejectedValue(new Error('Current password is incorrect'));
    render(<ChangePasswordCard />);
    await fill('Wrong-password-1', 'New-password-1', 'New-password-1');

    expect(await screen.findByRole('alert')).toHaveTextContent('Current password is incorrect');
    expect(screen.getByLabelText('Current password')).toHaveValue('Wrong-password-1');
  });
});
