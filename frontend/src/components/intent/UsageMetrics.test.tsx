import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { UsageMetrics } from './UsageMetrics';

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

    expect(screen.queryByText('Agent launch')).not.toBeInTheDocument();
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
    expect(screen.getByText('Agent launch')).toBeInTheDocument();
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

    await userEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('Agent launch')).toBeInTheDocument();
  });
});
