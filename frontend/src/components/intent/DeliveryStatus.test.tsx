import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { DeliveryStatus } from './DeliveryStatus';
import { intentsService } from '@/services/intents';
vi.mock('@/services/intents', () => ({
  intentsService: { previewDelivery: vi.fn(), retryDelivery: vi.fn() },
}));
const repo = {
  repoId: 'owner/web',
  provider: 'github',
  branch: 'intent/feature',
  baseBranch: 'develop',
  status: 'failed',
  reason: 'Provider unavailable',
  retryable: true,
};
const preview = {
  previewToken: 'checked-head',
  historical: false,
  retryable: true,
  canRecord: true,
  delivery: { status: 'partial' as const, repositories: [repo] },
};
const reload = vi.fn(async () => {});
const props = {
  projectId: 'project',
  intentId: 'intent',
  canRetry: true,
  delivery: preview.delivery,
  reload,
};
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(intentsService.previewDelivery).mockResolvedValue(preview);
  vi.mocked(intentsService.retryDelivery).mockResolvedValue({
    delivery: { status: 'in_progress', repositories: [repo] },
  });
});
it('shows the affected repository and checks delivery before retrying only publication', async () => {
  render(<DeliveryStatus {...props} />);
  const user = userEvent.setup();
  expect(screen.getByText('Provider unavailable')).toBeInTheDocument();
  await user.click(await screen.findByRole('button', { name: 'Retry opening pull request' }));
  await waitFor(() =>
    expect(intentsService.retryDelivery).toHaveBeenCalledWith('project', 'intent', 'checked-head'),
  );
  expect(reload).toHaveBeenCalled();
});
it('requires a fresh check after a stale confirmation and displays its explanation', async () => {
  vi.mocked(intentsService.retryDelivery).mockRejectedValue(
    new Error('The branch or pull request changed. Check again.'),
  );
  render(<DeliveryStatus {...props} />);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Retry opening pull request' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('The branch or pull request changed');
  await user.click(screen.getByRole('button', { name: 'Retry opening pull request' }));
  expect(intentsService.previewDelivery).toHaveBeenCalledTimes(2);
});
it('keeps completed links visible and hides retry for nonowners or active publication', () => {
  const { rerender } = render(<DeliveryStatus {...props} canRetry={false} />);
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  rerender(
    <DeliveryStatus {...props} delivery={{ status: 'in_progress', repositories: [repo] }} />,
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
  rerender(
    <DeliveryStatus
      {...props}
      delivery={{
        status: 'succeeded',
        repositories: [
          {
            ...repo,
            status: 'succeeded',
            pr: {
              prNumber: 7,
              prUrl: 'https://example.test/pr/7',
              branch: repo.branch,
              baseBranch: repo.baseBranch,
            },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('link', { name: 'Pull request #7' })).toHaveAttribute(
    'href',
    'https://example.test/pr/7',
  );
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
it('explains historical unknown status and a read-only assessment of closed work', async () => {
  vi.mocked(intentsService.previewDelivery).mockResolvedValue({
    ...preview,
    historical: true,
    retryable: false,
    delivery: {
      status: 'failed',
      repositories: [
        {
          ...repo,
          retryable: false,
          reason: 'The existing pull request is closed. Retry will not recreate it.',
        },
      ],
    },
  });
  render(<DeliveryStatus {...props} delivery={undefined} />);
  expect(screen.getByText('Pull request status unknown')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Check for pull requests' }));
  expect(await screen.findByText(/existing pull request is closed/)).toBeInTheDocument();
  expect(
    screen.queryByRole('button', { name: 'Retry opening pull request' }),
  ).not.toBeInTheDocument();
  expect(intentsService.retryDelivery).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Save check result' })).toBeNull();
});
it('shows an unconfirmed pull request as needing review without offering a retry', async () => {
  const uncertain = {
    ...repo,
    status: 'uncertain',
    retryable: false,
    reason: 'Check the branch pull requests at the provider.',
  };
  vi.mocked(intentsService.previewDelivery).mockResolvedValue({
    ...preview,
    retryable: false,
    canRecord: false,
    delivery: { status: 'failed' as const, repositories: [uncertain] },
  });
  render(<DeliveryStatus {...props} delivery={{ status: 'failed', repositories: [uncertain] }} />);
  const user = userEvent.setup();
  expect(screen.getByText(/Couldn’t identify the pull request/)).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /View pull request/ })).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Check for pull requests' }));
  await waitFor(() => expect(intentsService.previewDelivery).toHaveBeenCalled());
  expect(
    screen.queryByRole('button', { name: 'Retry opening pull request' }),
  ).not.toBeInTheDocument();
});

it('shows a recorded closed pull request as a result without a recovery action', () => {
  render(
    <DeliveryStatus
      {...props}
      delivery={{
        status: 'succeeded',
        repositories: [
          {
            ...repo,
            status: 'succeeded',
            prState: 'closed',
            pr: {
              prNumber: 8,
              prUrl: 'https://example.test/pr/8',
              branch: repo.branch,
              baseBranch: repo.baseBranch,
            },
          },
        ],
      }}
    />,
  );
  expect(screen.getByRole('link', { name: 'Pull request #8' })).toHaveAttribute(
    'href',
    'https://example.test/pr/8',
  );
  expect(screen.getByText(/was closed without merging/)).toBeVisible();
  expect(screen.queryByRole('button')).toBeNull();
});

it('shows a newly eligible repository before opening requests there', async () => {
  const additional = { ...repo, repoId: 'owner/api', status: 'pending' };
  vi.mocked(intentsService.previewDelivery).mockResolvedValue({
    ...preview,
    delivery: { status: 'pending', repositories: [additional] },
  });
  render(<DeliveryStatus {...props} />);
  await userEvent.click(screen.getByRole('button', { name: 'Retry opening pull request' }));
  expect(await screen.findByText(/owner\/api · Ready/)).toBeVisible();
  expect(intentsService.retryDelivery).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Check for pull requests' })).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: 'Open pull request' }));
  expect(intentsService.retryDelivery).toHaveBeenCalledTimes(1);
});
