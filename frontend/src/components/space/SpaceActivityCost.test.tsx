import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrictMode } from 'react';
import { act, render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';

const fixtures = vi.hoisted(() => ({ get: vi.fn() }));
vi.mock('@/services/api', () => ({ api: { get: fixtures.get } }));

import { SpaceActivityCost } from './SpaceActivityCost';
import { queryClient } from '@/lib/queryClient';
import type { Intent } from '@/services/intents';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

const intent = (id: string, status: Intent['status'], completedAt: string | null) =>
  ({ id, title: id, status, completedAt, createdAt: daysAgo(60), updatedAt: daysAgo(1) }) as Intent;

const INTENTS = [
  intent('recent-success', 'SUCCEEDED', daysAgo(5)),
  intent('recent-failure', 'FAILED', daysAgo(5)),
  intent('old-success', 'SUCCEEDED', daysAgo(45)),
  intent('undated-success', 'SUCCEEDED', null),
];

const USAGE = {
  perIntent: [],
  project: {
    metrics: {
      tokensInput: 10_000,
      tokensOutput: 5_000,
      contextWindowPct: 60,
      agentLaunchMs: 900,
      artifactsCreated: 5,
    },
    cost: { totalCost: 1.23, currency: 'USD', anyUnpriced: false, anyEstimated: false },
  },
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('SpaceActivityCost', () => {
  beforeEach(() => {
    queryClient.clear();
    fixtures.get.mockReset();
  });
  afterEach(() => queryClient.clear());

  const loadUsage = () => userEvent.click(screen.getByRole('button', { name: 'Load usage' }));

  it('shows the activity from the loaded list at once and fetches usage only when an owner asks, with an honest loading message', async () => {
    const pending = deferred<typeof USAGE>();
    fixtures.get.mockReturnValue(pending.promise);
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    expect(screen.getByRole('region', { name: 'Activity & cost' })).toBeInTheDocument();
    expect(screen.getByTestId('space-activity-count')).toHaveTextContent('1');
    expect(screen.getByText('Last completion').parentElement).toHaveTextContent('5d ago');
    expect(fixtures.get).not.toHaveBeenCalled();
    const button = screen.getByRole('button', { name: 'Load usage' });
    expect(button.parentElement).toHaveTextContent('Can take up to a minute.');
    await userEvent.click(button);
    expect(fixtures.get).toHaveBeenCalledTimes(1);
    expect(fixtures.get.mock.calls[0][0]).toBe('/projects/p1/intents/metrics');
    expect(screen.getByRole('status', { name: /Loading usage/ })).toBeInTheDocument();
    expect(screen.queryByRole('progressbar')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load usage' })).not.toBeInTheDocument();
    act(() => pending.resolve(USAGE));
    expect(await screen.findByText('10.0K')).toBeInTheDocument();
    expect(screen.getByText('5.0K')).toBeInTheDocument();
    expect(screen.getByText('$1.23')).toBeInTheDocument();
    expect(screen.queryByText('Agent launch')).not.toBeInTheDocument();
    expect(screen.queryByText(/Context window/)).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts created')).not.toBeInTheDocument();
  });

  it('counts the seconds while usage loads instead of spinning, and explains the wait after 8 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const pending = deferred<typeof USAGE>();
      fixtures.get.mockReturnValue(pending.promise);
      render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
      await loadUsage();
      const status = screen.getByRole('status', { name: /Loading usage/ });
      expect(status).toHaveTextContent(/^Reading usage for every run… 0 s$/);
      expect(status.querySelector('.animate-spin, [class*="animate-spin"]')).toBeNull();
      act(() => {
        vi.advanceTimersByTime(3_000);
      });
      expect(status).toHaveTextContent('Reading usage for every run… 3 s');
      act(() => {
        vi.advanceTimersByTime(6_000);
      });
      expect(status).toHaveTextContent('Reading usage for every run… 9 s');
      expect(status).toHaveTextContent(/up to a minute on large spaces/);
      act(() => pending.resolve(USAGE));
      expect(await screen.findByText('$1.23')).toBeInTheDocument();
      expect(screen.queryByRole('status', { name: /Loading usage/ })).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('shows "Not available" when the summary comes back without numbers, never zeros', async () => {
    fixtures.get.mockResolvedValue({ perIntent: [], project: null });
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    await loadUsage();
    const usage = await screen.findByRole('group', { name: 'Usage and cost' });
    expect(within(usage).getAllByText('Not available')).toHaveLength(3);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('aborts the request when the page is left before it answers', async () => {
    const pending = deferred<typeof USAGE>();
    fixtures.get.mockReturnValue(pending.promise);
    const { unmount } = render(
      <SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />,
    );
    await loadUsage();
    const signal = fixtures.get.mock.calls[0][1]?.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    unmount();
    expect(signal.aborted).toBe(true);
  });

  it('still loads under StrictMode, where the first effect run is aborted immediately', async () => {
    fixtures.get.mockImplementation((_path: string, { signal }: { signal: AbortSignal }) =>
      signal.aborted
        ? Promise.reject(new DOMException('The request was aborted.', 'AbortError'))
        : Promise.resolve(USAGE),
    );
    render(
      <StrictMode>
        <SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />
      </StrictMode>,
    );
    await loadUsage();
    expect(await screen.findByText('$1.23')).toBeInTheDocument();
    expect(screen.queryByText("Couldn't load usage and cost")).not.toBeInTheDocument();
  });

  it('shows a fresh cached usage on the next visit without asking or calling again', async () => {
    fixtures.get.mockResolvedValue(USAGE);
    const first = render(
      <SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />,
    );
    await loadUsage();
    expect(await screen.findByText('$1.23')).toBeInTheDocument();
    first.unmount();
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    expect(await screen.findByText('$1.23')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Load usage' })).not.toBeInTheDocument();
    expect(fixtures.get).toHaveBeenCalledTimes(1);
  });

  it('counts recent completions from the loaded list and says what it is based on', () => {
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    expect(screen.getByTestId('space-activity-count')).toHaveTextContent('1');
    expect(screen.getByText('Completed in the last 30 days')).toBeInTheDocument();
    expect(
      screen.getByText(/A completion date is missing for 1 finished intent./),
    ).toBeInTheDocument();
    expect(fixtures.get).not.toHaveBeenCalled();
  });

  it('never renders a zero: unpriced cost is "Not available" and an unknown output count is hidden', async () => {
    fixtures.get.mockResolvedValue({
      perIntent: [],
      project: {
        metrics: { tokensInput: 100, tokensOutput: 0 },
        cost: { totalCost: 0, currency: 'USD', anyUnpriced: true },
      },
    });
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    await loadUsage();
    expect(await screen.findByText('Not available')).toBeInTheDocument();
    expect(screen.getByText('Input tokens')).toBeInTheDocument();
    expect(screen.queryByText('Output tokens')).not.toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('says "None" with the last completion instead of a bare 0 when the full list has no recent completion', () => {
    render(
      <SpaceActivityCost
        projectId="p1"
        intents={[
          intent('old-success', 'SUCCEEDED', daysAgo(45)),
          intent('f', 'FAILED', daysAgo(2)),
        ]}
        canSeeCost
        now={NOW}
      />,
    );
    const count = screen.getByTestId('space-activity-count');
    expect(count).toHaveTextContent('None');
    expect(screen.getByText('Last completion').parentElement).toHaveTextContent(
      /^Last completion7 Oct 2026$/,
    );
    expect(screen.queryByText('0')).not.toBeInTheDocument();
  });

  it('says "None yet" for the last completion when nothing has ever completed', () => {
    render(
      <SpaceActivityCost
        projectId="p1"
        intents={[intent('f', 'FAILED', daysAgo(2))]}
        canSeeCost={false}
        now={NOW}
      />,
    );
    expect(screen.getByTestId('space-activity-count')).toHaveTextContent('None');
    expect(screen.getByText('Last completion').parentElement).toHaveTextContent('None yet');
  });

  it('marks the completion count as not available when the list is partial and shows nothing recent', () => {
    render(
      <SpaceActivityCost
        projectId="p1"
        intents={[intent('undated', 'SUCCEEDED', null)]}
        canSeeCost
        now={NOW}
      />,
    );
    expect(screen.queryByTestId('space-activity-count')).not.toBeInTheDocument();
    expect(screen.getByText('Completed in the last 30 days').parentElement).toHaveTextContent(
      'Not available',
    );
    expect(screen.getByText(/completion date is missing/)).toBeInTheDocument();
  });

  it('states when no usage has been recorded instead of showing zeros', async () => {
    fixtures.get.mockResolvedValue({
      perIntent: [],
      project: { metrics: {}, cost: { totalCost: 0, currency: 'USD', anyUnpriced: false } },
    });
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    await loadUsage();
    expect(await screen.findByText('No usage recorded for this space yet.')).toBeInTheDocument();
    expect(screen.queryByText('$0.00')).not.toBeInTheDocument();
  });

  it('shows an error with Retry instead of an empty result when usage fails', async () => {
    fixtures.get.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(USAGE);
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost now={NOW} />);
    await loadUsage();
    expect(await screen.findByText("Couldn't load usage and cost")).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('$1.23')).toBeInTheDocument();
    expect(fixtures.get).toHaveBeenCalledTimes(2);
  });

  it('lets a member see recent completions without ever being offered owner usage', () => {
    render(<SpaceActivityCost projectId="p1" intents={INTENTS} canSeeCost={false} now={NOW} />);
    expect(screen.getByRole('region', { name: 'Activity' })).toBeInTheDocument();
    expect(screen.getByTestId('space-activity-count')).toHaveTextContent('1');
    expect(screen.queryByRole('button', { name: 'Load usage' })).not.toBeInTheDocument();
    expect(fixtures.get).not.toHaveBeenCalled();
  });
});
