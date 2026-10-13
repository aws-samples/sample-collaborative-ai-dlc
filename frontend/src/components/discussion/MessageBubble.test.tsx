import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { groupMessages } from '@/lib/discussion';
import type { DiscussionMessage } from '@/services/discussions';
import { MessageBubble } from './MessageBubble';

const message = (assistStatus?: DiscussionMessage['assistStatus']): DiscussionMessage => ({
  id: 'advice-1',
  requestId: 'request-1',
  authorId: 'quorum',
  authorName: 'Quorum',
  authorType: 'agent',
  content: 'Consider adding coverage.',
  mentions: [],
  createdAt: '2026-10-13T10:00:00Z',
  updatedAt: '2026-10-13T10:00:30Z',
  discussionId: 'discussion-1',
  sprintId: '',
  assistStatus,
});

it('shows durable advisory progress, outcome and the existing retry action without inferring approval', async () => {
  const retry = vi.fn();
  const group = (status?: DiscussionMessage['assistStatus']) => groupMessages([message(status)])[0];
  const { rerender } = render(
    <MessageBubble group={group('running')} currentUserId="member" onAssistRetry={retry} />,
  );
  expect(screen.getByText('running')).toBeInTheDocument();
  rerender(
    <MessageBubble group={group('completed')} currentUserId="member" onAssistRetry={retry} />,
  );
  expect(screen.getByText(/Advisory response completed/)).toBeInTheDocument();
  expect(screen.queryByText(/approved/i)).not.toBeInTheDocument();
  rerender(<MessageBubble group={group('failed')} currentUserId="member" onAssistRetry={retry} />);
  await userEvent.setup().click(screen.getByRole('button', { name: /failed - retry/ }));
  expect(retry).toHaveBeenCalledWith('advice-1');
  rerender(<MessageBubble group={group('failed')} currentUserId="member" />);
  expect(screen.getByText('Advisory response failed')).toBeInTheDocument();
  rerender(<MessageBubble group={group()} currentUserId="member" />);
  expect(screen.queryByText(/Advisory response completed/)).not.toBeInTheDocument();
});
