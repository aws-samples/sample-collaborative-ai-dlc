import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock('@/services/agents', () => ({
  agentsService: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
  },
}));

import { LaneSyncPolicyCard } from './LaneSyncPolicyCard';

beforeEach(() => {
  vi.clearAllMocks();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('LaneSyncPolicyCard', () => {
  it('loads the platform default and saves a changed policy', async () => {
    getSettings.mockResolvedValue({ laneSyncPolicy: 'before-stage' });
    updateSettings.mockResolvedValue({});
    const user = userEvent.setup();
    render(<LaneSyncPolicyCard />);

    const trigger = await screen.findByRole('combobox', { name: 'Platform lane sync' });
    expect(trigger).toHaveTextContent('Before each stage');

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'At merge-back only' }));
    await user.click(screen.getByRole('button', { name: 'Save default' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ laneSyncPolicy: 'none' }));
  });

  it('fails safely to no sync when the setting is absent', async () => {
    getSettings.mockResolvedValue({});
    render(<LaneSyncPolicyCard />);
    expect(await screen.findByRole('combobox', { name: 'Platform lane sync' })).toHaveTextContent(
      'At merge-back only',
    );
  });
});
