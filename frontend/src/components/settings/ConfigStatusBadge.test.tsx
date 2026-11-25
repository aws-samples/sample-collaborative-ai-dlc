import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/query';
import { ConfigStatusBadge } from './ConfigStatusBadge';

const pillOf = (text: string) => screen.getByText(text).closest('[data-tone]') as HTMLElement;

describe('ConfigStatusBadge', () => {
  it('keeps the legacy ok/notOk props working', () => {
    const { rerender } = render(<ConfigStatusBadge ok />);
    expect(pillOf('Configured')).toHaveAttribute('data-tone', 'success');

    rerender(<ConfigStatusBadge ok={false} />);
    expect(pillOf('Not configured')).toHaveAttribute('data-tone', 'neutral');

    rerender(<ConfigStatusBadge ok={false} notOkLabel="Missing" notOkTone="warning" />);
    expect(pillOf('Missing')).toHaveAttribute('data-tone', 'warning');

    rerender(<ConfigStatusBadge ok okLabel="Connected" />);
    expect(pillOf('Connected')).toHaveAttribute('data-tone', 'success');
  });

  it.each([
    ['configured', 'Configured', 'success'],
    ['incomplete', 'Setup incomplete', 'warning'],
    ['error', 'Needs attention', 'danger'],
    ['none', 'Not configured', 'neutral'],
    ['unknown', 'Status unavailable', 'warning'],
  ] as const)('maps status=%s to "%s"', (status, label, tone) => {
    render(<ConfigStatusBadge status={status} />);
    expect(pillOf(label)).toHaveAttribute('data-tone', tone);
  });

  it('lets a status keep a custom label', () => {
    render(<ConfigStatusBadge status="incomplete" label="Token missing" />);
    expect(pillOf('Token missing')).toHaveAttribute('data-tone', 'warning');
  });

  it('uses warning tokens and the 11 px floor instead of the amber workaround', () => {
    render(<ConfigStatusBadge ok={false} notOkTone="warning" />);
    const pill = pillOf('Not configured');
    expect(pill.className).toContain('text-warning-fg');
    expect(pill.className).toContain('text-2xs');
    expect(pill.className).not.toMatch(/amber|text-\[\d+px\]/);
  });
});
