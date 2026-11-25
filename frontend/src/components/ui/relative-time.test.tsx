import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { formatAbsolute } from '@/lib/timeAgo';
import { RelativeTime } from './relative-time';

const NOW = new Date('2026-08-05T15:08:00Z');

describe('RelativeTime', () => {
  it('renders the prefixed relative text in a focusable <time> with a 24 px target (P2-10)', () => {
    render(<RelativeTime value="2026-08-05T12:08:00Z" now={NOW} prefix="Updated" />);
    const time = screen.getByText('3h ago');
    expect(time.tagName).toBe('TIME');
    expect(time).toHaveAttribute('dateTime', '2026-08-05T12:08:00.000Z');
    expect(time.parentElement).toHaveTextContent('Updated 3h ago');
    expect(time).toHaveAttribute('tabindex', '0');
    expect(time).toHaveClass('inline-flex', 'min-h-6', 'items-center');
  });

  it.each([
    [{}, '3h ago'],
    [{ format: 'age' as const }, '3 h ago'],
  ])('exposes the absolute timestamp in a tooltip on focus (%o)', async (props, text) => {
    render(<RelativeTime value="2026-08-05T12:08:00Z" now={NOW} {...props} />);
    expect(screen.getByText(text)).toBeInTheDocument();
    await userEvent.tab();
    expect(
      await screen.findByRole('tooltip', { name: formatAbsolute('2026-08-05T12:08:00Z') }),
    ).toBeInTheDocument();
  });

  it('switches to an absolute date after absoluteAfterDays, but never in age format (R3-6)', () => {
    render(
      <>
        <RelativeTime value="2026-06-01T10:00:00Z" now={NOW} absoluteAfterDays={30} />
        <RelativeTime value="2026-06-07T10:00:00Z" now={NOW} format="age" />
      </>,
    );
    expect(screen.getByText('1 Jun 2026').tagName).toBe('TIME');
    expect(screen.getByText('59 days ago').tagName).toBe('TIME');
  });

  it('renders a dash without a tooltip for a missing or invalid value', () => {
    render(
      <>
        <RelativeTime value={null} now={NOW} />
        <RelativeTime value="not a date" now={NOW} />
      </>,
    );
    expect(screen.getAllByText('—')).toHaveLength(2);
    expect(document.querySelector('time')).toBeNull();
  });
});
