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
  expect(screen.getByText(/does not regenerate code/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Check delivery' }));
  await user.click(await screen.findByRole('button', { name: 'Retry delivery' }));
  await waitFor(() =>
    expect(intentsService.retryDelivery).toHaveBeenCalledWith('project', 'intent', 'checked-head'),
  );
  expect(reload).toHaveBeenCalled();
});
it('requires a fresh check after a stale confirmation and displays its explanation', async () => {
  vi.mocked(intentsService.retryDelivery).mockRejectedValue(
    new Error('Delivery state changed. Check again.'),
  );
  render(<DeliveryStatus {...props} />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Check delivery' }));
  await user.click(await screen.findByRole('button', { name: 'Retry delivery' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Delivery state changed');
  expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument();
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
  expect(screen.getByRole('link', { name: 'View pull request #7' })).toHaveAttribute(
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
  expect(screen.getByText('Delivery not yet verified')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Check delivery' }));
  expect(await screen.findByText(/This older run/)).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry delivery' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Save delivery assessment' })).toBeInTheDocument();
});
