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

import { PrStrategyCard } from './PrStrategyCard';

beforeEach(() => {
  vi.clearAllMocks();
  window.HTMLElement.prototype.hasPointerCapture = vi.fn().mockReturnValue(false);
  window.HTMLElement.prototype.setPointerCapture = vi.fn();
  window.HTMLElement.prototype.releasePointerCapture = vi.fn();
  window.HTMLElement.prototype.scrollIntoView = vi.fn();
});

describe('PrStrategyCard', () => {
  it('loads the platform default and saves a changed strategy', async () => {
    getSettings.mockResolvedValue({ prStrategy: 'pr-per-unit' });
    updateSettings.mockResolvedValue({});
    const user = userEvent.setup();
    render(<PrStrategyCard />);

    const trigger = await screen.findByRole('combobox', { name: 'Platform PR strategy' });
    expect(trigger).toHaveTextContent('PR per unit');

    await user.click(trigger);
    await user.click(await screen.findByRole('option', { name: 'Intent PR' }));
    await user.click(screen.getByRole('button', { name: 'Save default' }));

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ prStrategy: 'intent-pr' }));
  });

  it('fails safely to Intent PR when the setting is absent', async () => {
    getSettings.mockResolvedValue({});
    render(<PrStrategyCard />);
    expect(await screen.findByRole('combobox', { name: 'Platform PR strategy' })).toHaveTextContent(
      'Intent PR',
    );
  });
});
