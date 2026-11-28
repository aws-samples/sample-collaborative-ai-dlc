import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/query';
import { Users } from 'lucide-react';
import { SettingsCard } from './SettingsCard';

describe('SettingsCard', () => {
  it('titles the card with an h2: the first heading level below the page h1 (axe heading-order)', () => {
    render(
      <>
        <h1>Platform Admin</h1>
        <SettingsCard icon={<Users />} title="User Management" description="Who can sign in.">
          <p>content</p>
        </SettingsCard>
      </>,
    );
    expect(screen.getByRole('heading', { level: 2, name: 'User Management' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3 })).toBeNull();
    expect(screen.getByText('Who can sign in.')).toBeInTheDocument();
  });

  it('stacks the header action under the text below `sm` so the description keeps its width (R3-13)', () => {
    render(
      <SettingsCard
        icon={<Users />}
        title="Members"
        description="Who can access this space and what they're allowed to do."
        headerAction={<button type="button">Add member</button>}
      >
        <p>content</p>
      </SettingsCard>,
    );
    const action = screen.getByRole('button', { name: 'Add member' }).parentElement!;
    expect(action).toHaveClass('w-full', 'sm:w-auto');
    expect(action.parentElement).toHaveClass('flex-wrap');
  });
});
