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

import { AgentClisCard } from './AgentClisCard';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('AgentClisCard', () => {
  it('shows every CLI enabled by default and saves a disabled CLI', async () => {
    getSettings.mockResolvedValue({});
    updateSettings.mockResolvedValue({});
    const user = userEvent.setup();
    render(<AgentClisCard />);

    const codex = await screen.findByRole('switch', { name: 'Codex' });
    for (const name of ['Kiro', 'Claude Code', 'OpenCode', 'Codex']) {
      expect(screen.getByRole('switch', { name })).toBeChecked();
    }
    const save = screen.getByRole('button', { name: 'Save Agent CLIs' });
    expect(save).toBeDisabled();

    await user.click(codex);
    expect(codex).not.toBeChecked();
    await user.click(save);

    await waitFor(() => expect(updateSettings).toHaveBeenCalledWith({ disabledClis: ['codex'] }));
  });

  it('loads the saved disabled set and keeps the last enabled CLI on', async () => {
    getSettings.mockResolvedValue({ disabledClis: ['claude', 'opencode', 'codex'] });
    render(<AgentClisCard />);

    const kiro = await screen.findByRole('switch', { name: 'Kiro' });
    expect(kiro).toBeChecked();
    expect(kiro).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Codex' })).not.toBeChecked();
    expect(screen.getByText(/at least one CLI must stay enabled/)).toBeInTheDocument();
  });

  it('blocks saving when the stored settings fail to load', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    getSettings.mockRejectedValue(new Error('network'));
    render(<AgentClisCard />);

    expect(await screen.findByRole('alert')).toHaveTextContent(/Couldn.t load/);
    expect(screen.getByRole('switch', { name: 'Codex' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save Agent CLIs' })).toBeDisabled();
    expect(updateSettings).not.toHaveBeenCalled();
  });
});
