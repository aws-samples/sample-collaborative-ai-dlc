import { beforeEach, describe, it, expect, vi } from 'vitest';
import { render, screen, within } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { UsageMetrics } from './UsageMetrics';

type Globals = { intentUsageDetail?: unknown; intentUsageRows?: unknown[] };
const g = globalThis as Globals;

vi.mock('@/contexts/IntentContext', () => {
  const value = () => ({
    detail: g.intentUsageDetail ?? null,
    stageRows: g.intentUsageRows ?? [],
  });
  return { useIntent: value, useIntentOptional: value };
});

beforeEach(() => {
  g.intentUsageDetail = null;
  g.intentUsageRows = [];
});

describe('UsageMetrics — coreOnly', () => {
  const fullMetrics = {
    tokensInput: 5000,
    tokensOutput: 2000,
    contextWindowPct: 45,
    agentLaunchMs: 1200,
    artifactsCreated: 3,
    questionsAsked: 2,
  };

  it('renders only Input/Output/Total tokens and Cost when coreOnly is true', () => {
    render(
      <UsageMetrics
        metrics={fullMetrics}
        cost={{ totalCost: 0.42, currency: 'USD', priced: true }}
        coreOnly
      />,
    );
    expect(screen.getByText('Input tokens')).toBeInTheDocument();
    expect(screen.getByText('Output tokens')).toBeInTheDocument();
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();

    expect(screen.queryByText('Peak dispatch delay')).not.toBeInTheDocument();
    expect(screen.queryByText('Artifacts created')).not.toBeInTheDocument();
    expect(screen.queryByText('Questions asked')).not.toBeInTheDocument();
    expect(screen.queryByText('Context window')).not.toBeInTheDocument();
  });

  it('never shows a disclosure toggle when coreOnly is true (advanced is fully suppressed)', () => {
    render(
      <UsageMetrics
        metrics={fullMetrics}
        cost={{ totalCost: 0.42, currency: 'USD', priced: true }}
        coreOnly
      />,
    );
    expect(screen.queryByTestId('usage-more-stats')).not.toBeInTheDocument();
  });

  it('shows all metrics by default (neither coreOnly nor collapsibleAdvanced)', () => {
    render(
      <UsageMetrics
        metrics={fullMetrics}
        cost={{ totalCost: 0.42, currency: 'USD', priced: true }}
      />,
    );
    expect(screen.getByText('Peak dispatch delay')).toBeInTheDocument();
    expect(screen.getByText('Artifacts created')).toBeInTheDocument();
    expect(screen.getByText('Context window')).toBeInTheDocument();
  });
});

describe('UsageMetrics — collapsibleAdvanced disclosure control', () => {
  it('renders a polished "Usage details" button with icon and chevron', async () => {
    render(
      <UsageMetrics
        metrics={{ tokensInput: 1000, tokensOutput: 500, agentLaunchMs: 800 }}
        collapsibleAdvanced
      />,
    );
    const toggle = screen.getByTestId('usage-more-stats');
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(toggle).toHaveTextContent('Usage details');
    const details = document.getElementById(toggle.getAttribute('aria-controls')!);
    expect(details).toHaveAttribute('hidden');

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(details).not.toHaveAttribute('hidden');
    expect(screen.getByText('Peak dispatch delay')).toBeInTheDocument();
  });

  it('reveals assembled prompt size and cache reads in the expanded usage details', async () => {
    render(
      <UsageMetrics
        metrics={{
          tokensInput: 1000,
          tokensOutput: 500,
          contextWindowPct: 45,
          agentLaunchMs: 800,
          promptBytes: 2500,
          tokensCacheRead: 1800,
        }}
        cost={{ totalCost: 0.42, currency: 'USD', priced: true }}
        collapsibleAdvanced
      />,
    );
    expect(screen.queryByText('Assembled prompts')).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId('usage-more-stats'));

    expect(screen.getByText('Peak dispatch delay')).toBeInTheDocument();
    expect(screen.getByText('Context window')).toBeInTheDocument();
    expect(screen.getByText('Assembled prompts')).toBeInTheDocument();
    expect(screen.getByText('2.4 KB')).toBeInTheDocument();
    expect(screen.getByText('Cache read tokens')).toBeInTheDocument();
    expect(screen.getByText('1.8K')).toBeInTheDocument();
  });
});

// O7 / D5: the run card is one metric row plus a Details disclosure; the
// diagnostic metrics are no longer part of it (they belong to Audit).
describe('UsageMetrics — compact summary', () => {
  it('keeps tokens and cost visible and reveals the labelled token breakdown on demand', async () => {
    render(
      <UsageMetrics
        metrics={{
          tokensInput: 1000,
          tokensOutput: 500,
          contextWindowPct: 45,
          agentLaunchMs: 800,
          promptBytes: 2500,
          tokensCacheRead: 1800,
        }}
        cost={{ totalCost: 0.42, currency: 'USD', priced: true }}
        compact
        collapsibleAdvanced
      />,
    );

    const row = screen.getByRole('group', { name: 'Run cost and usage' });
    expect(within(row).getByText('Tokens')).toBeInTheDocument();
    expect(within(row).getByText('3.3K')).toBeInTheDocument();
    expect(within(row).getByText('$0.42')).toBeInTheDocument();
    expect(screen.queryByText('Uncached input')).not.toBeInTheDocument();

    const toggle = screen.getByRole('button', { name: 'Details' });
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    await userEvent.click(toggle);

    expect(screen.getByText('Uncached input')).toBeInTheDocument();
    expect(screen.getByText('1.0K')).toBeInTheDocument();
    expect(screen.getByText('Output')).toBeInTheDocument();
    expect(screen.getByText('Cache reads')).toBeInTheDocument();
    expect(screen.getByText('1.8K')).toBeInTheDocument();
    expect(screen.getByText('Total')).toBeInTheDocument();
    expect(screen.queryByText('Peak dispatch delay')).not.toBeInTheDocument();
    expect(screen.queryByText('Assembled prompts')).not.toBeInTheDocument();
    expect(screen.queryByText('Context window')).not.toBeInTheDocument();
  });

  it('explains the gap between the stage totals and the run total', async () => {
    render(
      <UsageMetrics
        metrics={{ tokensInput: 40_000, tokensOutput: 5_900 }}
        cost={{ totalCost: 0.2, currency: 'USD', priced: true }}
        compact
        collapsibleAdvanced
        stageTokens={30_000}
      />,
    );

    await userEvent.click(screen.getByRole('button', { name: 'Details' }));
    expect(screen.getByText('Other')).toBeInTheDocument();
    expect(screen.getByText('15.9K')).toBeInTheDocument();
    expect(screen.getByText(/setup, questions/)).toBeInTheDocument();
  });

  it('preserves zero usage and an unavailable cost in the compact summary', () => {
    render(
      <UsageMetrics
        metrics={{ tokensInput: 0, tokensOutput: 0 }}
        cost={{ totalCost: 0, currency: 'USD', priced: false }}
        compact
        collapsibleAdvanced
      />,
    );

    expect(screen.getByText('Tokens')).toBeInTheDocument();
    expect(screen.getByText('0')).toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Details' })).toBeInTheDocument();
  });

  // D5: "Wall time" on a run that waited 109 days for a human answers nothing;
  // it is the elapsed time, and agent-active time only when stages recorded it.
  it('renders elapsed time and stages run beside tokens and cost when supplied', () => {
    render(
      <UsageMetrics
        metrics={{ tokensInput: 1000, tokensOutput: 500 }}
        cost={{ totalCost: 0.42, currency: 'USD', priced: true }}
        compact
        wallTime="6m 14s"
        stagesRun={{ done: 3, total: 7 }}
      />,
    );

    expect(screen.getByText('Elapsed')).toBeInTheDocument();
    expect(screen.queryByText('Wall time')).not.toBeInTheDocument();
    expect(screen.getByText('6m 14s')).toBeInTheDocument();
    expect(screen.getByText('Stages run')).toBeInTheDocument();
    expect(screen.getByText('3 of 7')).toBeInTheDocument();
    expect(screen.queryByText('Active time')).not.toBeInTheDocument();
  });

  it('adds agent-active time from the stage rows when at least one stage ran', () => {
    g.intentUsageRows = [
      {
        stageId: 'a',
        state: 'SUCCEEDED',
        startedAt: '2026-01-01T10:00:00Z',
        completedAt: '2026-01-01T10:04:00Z',
        waitMs: 60_000,
        parkedAt: null,
      },
      {
        stageId: 'b',
        state: 'WAITING_FOR_HUMAN',
        startedAt: '2026-01-01T10:04:00Z',
        completedAt: null,
        waitMs: 0,
        parkedAt: '2026-01-01T10:06:00Z',
      },
      { stageId: 'c', state: 'PENDING', startedAt: null, completedAt: null, waitMs: 0 },
    ];
    vi.useFakeTimers({ now: new Date('2026-03-01T10:00:00Z') });
    try {
      render(
        <UsageMetrics
          metrics={{ tokensInput: 1000, tokensOutput: 500 }}
          compact
          wallTime="59d 0h"
          stagesRun={{ done: 1, total: 3 }}
        />,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(screen.getByText('Elapsed')).toBeInTheDocument();
    expect(screen.getByText('59d 0h')).toBeInTheDocument();
    expect(screen.getByText('Active time')).toBeInTheDocument();
    expect(screen.getByText('5m 0s')).toBeInTheDocument();
  });

  it('shows stages run as not available instead of dropping the stat when the plan is unknown', () => {
    render(
      <UsageMetrics
        metrics={{ tokensInput: 1000, tokensOutput: 500 }}
        compact
        wallTime="6m 14s"
        stagesRun={null}
      />,
    );

    const stat = screen.getByText('Stages run').closest('[data-state]');
    expect(stat).toHaveAttribute('data-state', 'missing');
    expect(stat).toHaveTextContent('Not available');
  });

  it('does not turn a missing token direction into a zero count', () => {
    render(
      <UsageMetrics
        metrics={{ tokensInput: 1200 }}
        coreOnly
        showMissingValues
        cost={{ totalCost: 0, currency: 'USD', priced: false }}
      />,
    );

    expect(screen.getByText('1.2K')).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
    expect(screen.queryByText('0')).not.toBeInTheDocument();
    expect(screen.getByText('Unavailable')).toBeInTheDocument();
  });

  it('labels absent usage and price as not recorded when there are samples without token counts', () => {
    render(<UsageMetrics metrics={{ artifactsCreated: 1 }} coreOnly showMissingValues />);

    expect(screen.getByText('Input tokens')).toBeInTheDocument();
    expect(screen.getByText('Output tokens')).toBeInTheDocument();
    expect(screen.getByText('Total tokens')).toBeInTheDocument();
    expect(screen.getByText('Cost')).toBeInTheDocument();
    expect(screen.getAllByText('Not recorded')).toHaveLength(4);
  });
});
