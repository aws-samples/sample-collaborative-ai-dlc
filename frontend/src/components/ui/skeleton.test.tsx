import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Skeleton } from './skeleton';

describe('Skeleton', () => {
  it('is hidden from assistive tech by default, so a page of skeletons announces nothing', () => {
    const { container } = render(
      <>
        {Array.from({ length: 18 }, (_, i) => (
          <Skeleton key={i} />
        ))}
      </>,
    );
    expect(screen.queryAllByRole('status')).toHaveLength(0);
    expect(container.querySelectorAll('[aria-hidden="true"]')).toHaveLength(18);
  });

  it('announces itself as a busy status when given a label', () => {
    render(<Skeleton label="Loading intents" />);
    const skeleton = screen.getByRole('status', { name: 'Loading intents' });
    expect(skeleton).toHaveAttribute('aria-busy', 'true');
    expect(skeleton.querySelector('.sr-only')).toHaveTextContent('Loading intents');
  });
});
