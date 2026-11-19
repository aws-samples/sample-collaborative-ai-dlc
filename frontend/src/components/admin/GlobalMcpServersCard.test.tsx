import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ApiError } from '@/services/api';

const getSettings = vi.fn();
const updateSettings = vi.fn();

vi.mock('@/services/agents', () => ({
  agentsService: {
    getSettings: (...args: unknown[]) => getSettings(...args),
    updateSettings: (...args: unknown[]) => updateSettings(...args),
    verifyMcpServers: vi.fn(),
  },
}));

import { GlobalMcpServersCard } from './GlobalMcpServersCard';

const GATEWAY_ONLY_ERROR =
  'This deployment serves custom MCP servers only through the AgentCore Gateway (runtime_mcp_credentials = "gateway_only").';

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GlobalMcpServersCard', () => {
  it('shows the Gateway-only notice and the API refusal when saving a server', async () => {
    getSettings.mockResolvedValue({
      customMcpServers: '{}',
      runtimeMcpCredentials: 'gateway_only',
    });
    updateSettings.mockRejectedValue(
      new ApiError(400, GATEWAY_ONLY_ERROR, {
        error: GATEWAY_ONLY_ERROR,
        code: 'runtime_mcp_gateway_only',
      }),
    );
    const user = userEvent.setup();
    render(<GlobalMcpServersCard />);

    expect(
      await screen.findByText(/serves custom MCP servers only through the AgentCore Gateway\./),
    ).toBeInTheDocument();
    const editor = screen.getByRole('textbox');
    await user.clear(editor);
    await user.click(editor);
    await user.paste('{"wiki":{"command":"npx"}}');
    await user.click(screen.getByRole('button', { name: /save/i }));

    await waitFor(() =>
      expect(updateSettings).toHaveBeenCalledWith({
        customMcpServers: '{"wiki":{"command":"npx"}}',
      }),
    );
    expect(await screen.findByText(GATEWAY_ONLY_ERROR)).toBeInTheDocument();
  });

  it('shows no notice under the default profile', async () => {
    getSettings.mockResolvedValue({ customMcpServers: '{}' });
    render(<GlobalMcpServersCard />);
    await waitFor(() => expect(getSettings).toHaveBeenCalled());
    expect(screen.queryByRole('note')).not.toBeInTheDocument();
  });
});
