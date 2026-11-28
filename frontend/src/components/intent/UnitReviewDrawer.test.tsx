import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type { IntentUnit, UnitReviewComment } from '@/services/intents';
import { UnitReviewDrawer } from './UnitLaneBoard';

const unitReviewComments = vi.fn();
const addressUnitFeedback = vi.fn();
const mayDecide = { value: true };
vi.mock('@/contexts/IntentContext', () => ({
  useIntent: () => ({
    projectId: 'p1',
    intentId: 'i1',
    stageRows: [
      {
        unitSlug: 'auth',
        sectionIndex: 1,
        state: 'SUCCEEDED',
        stageId: 'code',
        stageInstanceId: 'si-auth',
        order: 1,
      },
    ],
    stageAccess: (id: string | null) => ({ decide: mayDecide.value && id === 'si-auth' }),
  }),
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
    mayDecide.value = true;
  });

  // #838: a member who may not decide the producing stage reads the comments
  // but selects none — no checkbox, no Select all.
  it("is read-only for a member who may not decide the unit's producing stage", async () => {
    mayDecide.value = false;
    unitReviewComments.mockResolvedValueOnce({
      comments: [comment('c1', 'Fix the bound'), comment('c2', 'Rename the constant')],
    });
    render(<UnitReviewDrawer unit={unit} onClose={() => {}} />);

    await screen.findByText('Rename the constant');
    expect(screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).disabled)).toBe(
      true,
    );
    expect(screen.queryByRole('button', { name: 'Select all' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Address feedback' })).toBeDisabled();
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

  it('lists human comments first, folds automated ones, and offers Select all', async () => {
    const user = userEvent.setup();
    unitReviewComments.mockResolvedValueOnce({
      comments: [
        {
          ...comment('c1', 'Badge should hide when the count is 0.'),
          path: 'src/Badge.tsx',
          line: 18,
        },
        { ...comment('bot', 'CI: all checks passed'), user: { login: 'ci-bot' }, bot: true },
        comment('c2', 'Please add a test for 99+.'),
      ],
    });
    render(<UnitReviewDrawer unit={unit} onClose={() => {}} />);

    await screen.findByText('Please add a test for 99+.');
    expect(screen.getByText('Auth · Section 1')).toBeInTheDocument();
    expect(screen.queryByText('CI: all checks passed')).not.toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(2);

    await user.click(screen.getByRole('button', { name: 'Select all' }));
    expect(screen.getAllByRole('checkbox').every((box) => (box as HTMLInputElement).checked)).toBe(
      true,
    );
    expect(screen.getByText('2 of 3 selected')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Address feedback' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Clear selection' }));
    expect(screen.getByRole('button', { name: 'Address feedback' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: /1 automated comment/ }));
    expect(await screen.findByText('CI: all checks passed')).toBeInTheDocument();
    expect(screen.getAllByRole('checkbox')).toHaveLength(3);
    await user.click(screen.getAllByRole('checkbox')[2]);
    expect(screen.getByText('1 of 3 selected')).toBeInTheDocument();
  });

  it('queues only the selected comments and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    unitReviewComments.mockResolvedValueOnce({
      comments: [comment('c1', 'Fix the bound'), comment('c2', 'Rename the constant')],
    });
    addressUnitFeedback.mockResolvedValueOnce({});
    render(<UnitReviewDrawer unit={unit} onClose={onClose} />);

    await user.click(await screen.findByRole('checkbox', { name: /Rename the constant/ }));
    await user.click(screen.getByRole('button', { name: 'Address feedback' }));
    await waitFor(() =>
      expect(addressUnitFeedback).toHaveBeenCalledWith('p1', 'i1', 1, 'auth', [
        { repository: 'owner/api', commentId: 'c2' },
      ]),
    );
    expect(onClose).toHaveBeenCalled();
  });
});
