import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { AgentStatusBadge } from './AgentStatusBadge';

describe('AgentStatusBadge', () => {
  it('shows a timed-out run as a warning, not an unknown status', () => {
    render(<AgentStatusBadge status="timed_out" />);
    expect(screen.getByText('Timed out').closest('[data-tone]')).toHaveAttribute(
      'data-tone',
      'warning',
    );
    expect(screen.queryByText(/unknown/i)).not.toBeInTheDocument();
  });

  it('labels the compact timed-out dot and keeps it warning-colored', () => {
    render(<AgentStatusBadge status="timed_out" compact />);
    const dot = screen.getByRole('img', { name: 'Timed out' });
    expect(dot.querySelector('.bg-agent-warning')).not.toBeNull();
  });
});
