import { describe, expect, it } from 'vitest';
import { render, screen } from '@/test/query';
import { RouteFallback } from './RouteFallback';

describe('RouteFallback', () => {
  it('is a single labelled status region with a layout-shaped skeleton', () => {
    const { container } = render(<RouteFallback />);
    const status = screen.getByRole('status', { name: 'Loading page' });
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(screen.getAllByRole('status')).toHaveLength(1);
    expect(container.querySelectorAll('[data-skeleton="header"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-skeleton="row"]')).toHaveLength(3);
  });
});
