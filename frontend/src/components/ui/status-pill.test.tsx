import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { StatusPill } from './status-pill';
import { STATUS_REGISTRY } from '@/lib/statusModel';

const NOW = Date.parse('2026-11-22T12:00:00Z');
const daysAgo = (d: number) => new Date(NOW - d * 86_400_000).toISOString();

describe('StatusPill', () => {
  it.each([
    [{ kind: 'intent', status: 'SUCCEEDED' }, 'Completed'],
    [{ kind: 'intent', status: 'WAITING', since: daysAgo(108) }, 'Waiting for input · 108 days'],
    [{ kind: 'intent', status: 'FAILED', since: daysAgo(59) }, 'Failed 59 days ago'],
    [{ kind: 'unit', status: 'SOMETHING_ELSE' }, 'Something else'],
  ] as const)('renders %o as "%s"', (props, expected) => {
    render(<StatusPill {...props} now={NOW} />);
    expect(screen.getByText(expected)).toBeInTheDocument();
  });

  it('keeps the text size and tightens the box at size xs', () => {
    const { container } = render(<StatusPill kind="intent" status="RUNNING" size="xs" />);
    const pill = container.firstElementChild;
    expect(pill).toHaveClass('text-2xs', 'px-1.5', 'py-0', 'gap-1');
    expect(pill).not.toHaveClass('px-2', 'py-0.5', 'gap-1.5');
  });

  it('hides the icon from assistive technology', () => {
    const { container } = render(<StatusPill kind="stage" status="FAILED" size="md" />);
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it.each([
    ['RUNNING', false, 'running', true],
    ['RUNNING', true, 'warning', false],
    ['FAILED', false, 'danger', false],
  ] as const)('%s (stalled: %s) → tone %s, pulses: %s', (status, stalled, tone, pulses) => {
    const { container } = render(
      <StatusPill kind="intent" status={status} stalled={stalled} since={daysAgo(123)} now={NOW} />,
    );
    expect(container.firstElementChild).toHaveAttribute('data-tone', tone);
    const pulsing = container.querySelector('[data-pulse]');
    if (pulses) expect(pulsing?.className).toContain('motion-safe:animate-pulse');
    else expect(pulsing).toBeNull();
    expect(container.innerHTML).not.toMatch(/(?<!motion-safe:)animate-/);
    expect(container.innerHTML).not.toMatch(/text-\[(?:8|9|10)px\]/);
  });

  it('names a stalled run "Stalled", never "Running"', () => {
    render(<StatusPill kind="intent" status="RUNNING" stalled since={daysAgo(123)} now={NOW} />);
    expect(screen.getByText('Stalled · no activity for 4 months')).toBeInTheDocument();
    expect(screen.queryByText(/Running/)).toBeNull();
  });

  it.each([
    [{ status: 'WAITING', since: daysAgo(108) }, 'Waiting · 108 d', 'Waiting for input · 108 days'],
    [
      { status: 'RUNNING', stalled: true, since: daysAgo(123) },
      'Stalled · 4 mo',
      'Stalled · no activity for 4 months',
    ],
    [{ status: 'FAILED', since: daysAgo(59) }, 'Failed 59 d ago', 'Failed 59 days ago'],
  ] as const)(
    'compact %o shows "%s" and keeps the full label for assistive tech',
    (props, short, full) => {
      const { container } = render(<StatusPill kind="intent" {...props} now={NOW} compact />);
      const visible = screen.getByText(short);
      expect(visible).toHaveAttribute('aria-hidden', 'true');
      expect(visible).not.toHaveClass('truncate');
      expect(screen.getByText(full)).toHaveClass('sr-only');
      expect(container.firstElementChild).toHaveAttribute('title', full);
    },
  );

  it.each([
    [true, STATUS_REGISTRY.intent.WAITING.help],
    ['Checks upstream coverage.', 'Checks upstream coverage.'],
  ])('exposes hint=%s as a tooltip on focus', async (hint, expected) => {
    render(<StatusPill kind="intent" status="WAITING" hint={hint} />);
    await userEvent.tab();
    expect(await screen.findByRole('tooltip', { name: expected })).toBeInTheDocument();
  });
});
