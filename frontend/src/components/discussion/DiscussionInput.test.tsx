import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscussionInput } from './DiscussionInput';
import type { Member } from '@/services/projects';

const members: Member[] = [{ userId: 'u1', email: 'alice@example.com', role: 'member' }];

const renderInput = (overrides = {}) => {
  const props = {
    onSend: vi.fn(),
    onAssist: vi.fn(),
    onTyping: vi.fn(),
    members,
    ...overrides,
  };
  render(<DiscussionInput {...props} />);
  return props;
};

describe('DiscussionInput Quorum mention', () => {
  it('shows Quorum in the @ mention typeahead and inserts @quorum', async () => {
    const user = userEvent.setup();
    renderInput();

    await user.type(screen.getByPlaceholderText('Write a message...'), '@quo');
    await user.click(screen.getByRole('button', { name: /quorum/i }));

    expect(screen.getByPlaceholderText('Write a message...')).toHaveValue('@quorum ');
  });

  it('sends the full @quorum question through the normal message path', async () => {
    const user = userEvent.setup();
    const props = renderInput();

    await user.type(screen.getByPlaceholderText('Write a message...'), '@quorum check the risks');
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(props.onSend).toHaveBeenCalledWith('@quorum check the risks', []);
    expect(props.onAssist).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText('Write a message...')).toHaveValue('');
  });

  it('preserves member mentions in a Quorum question', async () => {
    const user = userEvent.setup();
    const props = renderInput();
    const input = screen.getByPlaceholderText('Write a message...');

    await user.type(input, '@quorum ask @ali');
    await user.click(screen.getByRole('button', { name: /alice/i }));
    await user.click(screen.getByRole('button', { name: 'Send message' }));

    expect(props.onSend).toHaveBeenCalledWith('@quorum ask @alice', ['u1']);
  });

  it('keeps slash commands as direct assist requests', async () => {
    const user = userEvent.setup();
    const props = renderInput();

    await user.type(screen.getByPlaceholderText('Write a message...'), '/ask check the risks');
    await user.keyboard('{Enter}');

    expect(props.onAssist).toHaveBeenCalledWith('ask', 'check the risks');
    expect(props.onSend).not.toHaveBeenCalled();
  });

  it('sends a normal message when assist is unavailable', async () => {
    const user = userEvent.setup();
    const props = renderInput({ onAssist: undefined });

    await user.type(screen.getByPlaceholderText('Write a message...'), '@quorum check the risks');
    await user.keyboard('{Enter}');

    expect(props.onSend).toHaveBeenCalledWith('@quorum check the risks', []);
  });
});
