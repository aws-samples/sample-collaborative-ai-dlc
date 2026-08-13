import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const preview = vi.fn();
const execute = vi.fn();

vi.mock('@/services/environments', () => ({
  environmentResetService: {
    preview: (...args: unknown[]) => preview(...args),
    execute: (...args: unknown[]) => execute(...args),
  },
}));

import { EnvironmentResetPanel } from './EnvironmentResetPanel';

const confirmation = 'RESET MANAGED ENVIRONMENTS';
const counts = {
  projects: 2,
  activeIntents: 1,
  environments: 4,
  revisions: 7,
  runtimes: 3,
  images: 6,
};

describe('EnvironmentResetPanel', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    preview.mockResolvedValue({ confirmation, marker: null, counts });
    execute.mockResolvedValue({
      marker: {
        status: 'IN_PROGRESS',
        attempt: 1,
        startedAt: '2026-08-13T00:00:00.000Z',
        startedBy: 'admin@example.com',
        updatedAt: '2026-08-13T00:00:00.000Z',
      },
    });
  });

  it('shows dry-run counts and requires exact typed confirmation', async () => {
    const user = userEvent.setup();
    render(<EnvironmentResetPanel />);

    expect(await screen.findByText('2')).toBeInTheDocument();
    expect(screen.getByText('Projects to reassign')).toBeInTheDocument();
    expect(screen.getByText('Active runs to cancel')).toBeInTheDocument();
    const reset = screen.getByRole('button', { name: 'Reset Managed Environments' });
    expect(reset).toBeDisabled();

    await user.type(screen.getByLabelText(/Type RESET MANAGED ENVIRONMENTS/), confirmation);
    expect(reset).toBeEnabled();
    await user.click(reset);

    expect(execute).toHaveBeenCalledWith(confirmation);
    expect(preview).toHaveBeenCalledTimes(2);
  });
});
