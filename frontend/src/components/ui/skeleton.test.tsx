import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it.each([
    [undefined, 'Loading'],
    ['Loading intents', 'Loading intents'],
  ])('announces itself as a busy status labelled %s', (label, name) => {
    render(<Skeleton label={label} />);
    const skeleton = screen.getByRole('status', { name });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton.querySelector('.sr-only')).toHaveTextContent(name);
  });

  it('decorative skeletons are hidden from assistive tech and carry no role', () => {
    render(
      <div role="status" aria-label="Loading members">
        <Skeleton decorative data-testid="bar" />
      </div>,
    );
    const bar = screen.getByTestId('bar');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(bar).not.toHaveAttribute('role');
    expect(bar).not.toHaveAttribute('aria-busy');
    expect(bar.textContent).toBe('');
    expect(screen.getAllByRole('status')).toHaveLength(1);
  });
});
