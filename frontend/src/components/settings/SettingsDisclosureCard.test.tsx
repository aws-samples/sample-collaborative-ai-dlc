import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { Github } from 'lucide-react';
import { SettingsDisclosureCard } from './SettingsDisclosureCard';

describe('SettingsDisclosureCard', () => {
  it('renders title, status, description and a collapsed trigger that keeps the form mounted', async () => {
    const user = userEvent.setup();
    render(
      <SettingsDisclosureCard
        icon={<Github />}
        title="GitHub OAuth app"
        status={<span>Credentials stored</span>}
        description="Lets members sign in with GitHub."
        defaultOpen={false}
      >
        <input aria-label="Client ID" />
      </SettingsDisclosureCard>,
    );
    const trigger = screen.getByRole('button', { name: 'GitHub OAuth app' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    expect(screen.getByText('Credentials stored')).toBeVisible();
    expect(screen.getByText('Lets members sign in with GitHub.')).toBeVisible();
    expect(screen.getByLabelText('Client ID')).not.toBeVisible();

    await user.click(screen.getByText('GitHub OAuth app'));
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByLabelText('Client ID')).toBeVisible();
  });

  it('opens when defaultOpen turns true later and never closes a panel the admin opened', async () => {
    const user = userEvent.setup();
    const { rerender } = render(
      <SettingsDisclosureCard
        icon={<Github />}
        title="GitHub App"
        description="d"
        defaultOpen={false}
      >
        body
      </SettingsDisclosureCard>,
    );
    const trigger = screen.getByRole('button', { name: 'GitHub App' });
    expect(trigger).toHaveAttribute('aria-expanded', 'false');

    rerender(
      <SettingsDisclosureCard icon={<Github />} title="GitHub App" description="d" defaultOpen>
        body
      </SettingsDisclosureCard>,
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    rerender(
      <SettingsDisclosureCard
        icon={<Github />}
        title="GitHub App"
        description="d"
        defaultOpen={false}
      >
        body
      </SettingsDisclosureCard>,
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'true');

    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <SettingsDisclosureCard
        icon={<Github />}
        title="GitHub App"
        description="d"
        defaultOpen={false}
      >
        body
      </SettingsDisclosureCard>,
    );
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('shows the optional summary while collapsed', () => {
    render(
      <SettingsDisclosureCard
        icon={<Github />}
        title="AWS CodeCommit"
        description="Role-based access."
        summary="eu-west-1 · role configured"
        defaultOpen={false}
      >
        body
      </SettingsDisclosureCard>,
    );
    expect(screen.getByText('eu-west-1 · role configured')).toBeVisible();
    expect(screen.getByRole('button', { name: 'AWS CodeCommit' })).toBeInTheDocument();
  });
});
