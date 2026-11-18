import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { DiscussionThread } from './DiscussionThread';
import type { DiscussionMessage } from '@/services/discussions';

const scrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollIntoView');
afterEach(() => {
  if (scrollIntoView) {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', scrollIntoView);
  } else {
    Reflect.deleteProperty(HTMLElement.prototype, 'scrollIntoView');
  }
});

describe('DiscussionThread pending Quorum requests', () => {
  it('shows an actionable assist failure alongside a saved question without duplicating it', async () => {
    Object.defineProperty(HTMLElement.prototype, 'scrollIntoView', {
      configurable: true,
      value: vi.fn(),
    });
    const question: DiscussionMessage = {
      id: 'dm-question',
      content: '@quorum check the risks',
      authorId: 'u1',
      authorName: 'Alice',
      authorType: 'user',
      mentions: ['u2'],
      createdAt: '2026-11-05T10:00:00.000Z',
      updatedAt: '2026-11-05T10:00:00.000Z',
      discussionId: 'd1',
      sprintId: 'i1',
    };
    const onRetry = vi.fn();
    render(
      <DiscussionThread
        messages={[question]}
        pending={[
          {
            id: question.id,
            content: question.content,
            mentions: question.mentions,
            status: 'failed',
            assistInstructions: 'check the risks',
          },
        ]}
        currentUserId="u1"
        hasMoreOlder={false}
        loadingOlder={false}
        onLoadOlder={vi.fn()}
        onRetry={onRetry}
        typingUsers={[]}
      />,
    );

    expect(screen.getAllByText(question.content)).toHaveLength(1);
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Quorum request not confirmed — retry' }));
    expect(onRetry).toHaveBeenCalledWith(question.id);
  });
});
