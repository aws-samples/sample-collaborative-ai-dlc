import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Badge } from './badge';

describe('Badge', () => {
  it('renders an inline <span> so it is valid inside buttons and paragraphs', () => {
    render(<Badge>Draft</Badge>);
    const badge = screen.getByText('Draft');
    expect(badge.tagName).toBe('SPAN');
  });

  it('size="sm" uses the 11px text-2xs scale and 3-unit icons', () => {
    render(<Badge size="sm">3</Badge>);
    const badge = screen.getByText('3');
    expect(badge).toHaveClass('h-5', 'text-2xs', '[&_svg]:size-3');
    expect(badge).not.toHaveClass('text-xs');
  });

  it('warning variant uses design tokens instead of raw yellow', () => {
    render(<Badge variant="warning">Stalled</Badge>);
    const badge = screen.getByText('Stalled');
    expect(badge).toHaveClass('bg-warning/15', 'text-warning-fg');
    expect(badge.className).not.toMatch(/yellow/);
  });
});
