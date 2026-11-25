import { describe, expect, it } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MetricRow, Stat } from './stat';

describe('Stat', () => {
  it('renders the label above a tabular-nums value', () => {
    render(<Stat label="Total tokens" value="12 345" />);
    const label = screen.getByText('Total tokens');
    const value = screen.getByText('12 345');
    expect(value).toHaveClass('tabular-nums');
    expect(label.compareDocumentPosition(value) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('says "Not available" when the value is missing, never 0', () => {
    render(<Stat label="Input tokens" value={0} state="missing" />);
    expect(screen.getByText('Not available')).toBeInTheDocument();
    expect(screen.queryByText('0')).toBeNull();
  });

  it('marks estimated values with ≈ and shows the hint', () => {
    render(<Stat label="Cost" value="4.20" state="estimated" hint="Based on list prices" />);
    expect(screen.getByText(/≈/)).toBeInTheDocument();
    expect(screen.getByText('Based on list prices')).toBeInTheDocument();
  });
});

describe('MetricRow', () => {
  it('groups its stats under one accessible name', () => {
    render(
      <MetricRow aria-label="Usage">
        <Stat label="Tokens" value="1 200" />
        <Stat label="Cost" value="0.42" />
        <Stat label="Duration" value="3m" />
      </MetricRow>,
    );
    const row = screen.getByRole('group', { name: 'Usage' });
    expect(within(row).getByText('Tokens')).toBeInTheDocument();
    expect(within(row).getByText('Duration')).toBeInTheDocument();
  });
});
