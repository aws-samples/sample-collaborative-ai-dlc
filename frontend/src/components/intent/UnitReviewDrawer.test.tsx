import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { IntentUnit, UnitReviewComment } from '@/services/intents';
import { UnitReviewDrawer } from './UnitLaneBoard';

const unitReviewComments = vi.fn();
const addressUnitFeedback = vi.fn();
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({ projectId: 'p1', intentId: 'i1' }),
}));
vi.mock('@/services/intents', () => ({
  intentsService: {
    unitReviewComments: (...args: unknown[]) => unitReviewComments(...args),
    addressUnitFeedback: (...args: unknown[]) => addressUnitFeedback(...args),
  },
}));

const unit: IntentUnit = {
  slug: 'auth',
  dependsOn: [],
  state: 'PR_READY',
  batchIndex: 0,
  branch: 'intent--s1-unit-auth',
  startedAt: null,
  mergedAt: null,
  failureReason: null,
  blockedOn: null,
  updatedAt: null,
  sectionIndex: 1,
};

const comment = (id: string, body: string): UnitReviewComment => ({
  id,
  version: 'v1',
  repository: 'owner/api',
  prNumber: 7,
  type: 'review',
  body,
  user: { login: 'reviewer' },
  path: null,
  line: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
  bot: false,
  system: false,
  previouslySelected: false,
});

describe('UnitReviewDrawer', () => {
  beforeAll(() => {
    // The drawer's ScrollArea observes its size; jsdom has no ResizeObserver.
    globalThis.ResizeObserver ??= class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  });

  beforeEach(() => {
    unitReviewComments.mockReset();
    addressUnitFeedback.mockReset();
  });

  it('refreshes to pick up comments posted after the drawer opened, keeping selections', async () => {
    const user = userEvent.setup();
    unitReviewComments.mockResolvedValueOnce({ comments: [] });
    render(<UnitReviewDrawer unit={unit} onClose={() => {}} />);

    expect(await screen.findByText('No review comments yet.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Address feedback' })).toBeDisabled();

    unitReviewComments.mockResolvedValueOnce({ comments: [comment('c1', 'Fix the bound')] });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await user.click(await screen.findByRole('checkbox'));

    unitReviewComments.mockResolvedValueOnce({
      comments: [comment('c1', 'Fix the bound'), comment('c2', 'Rename the constant')],
    });
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('Rename the constant');

    const [first, second] = screen.getAllByRole('checkbox');
    expect(first).toBeChecked();
    expect(second).not.toBeChecked();
    expect(unitReviewComments).toHaveBeenCalledTimes(3);
    expect(unitReviewComments).toHaveBeenLastCalledWith('p1', 'i1', 1, 'auth');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Address feedback' })).toBeEnabled(),
    );
  });
});
