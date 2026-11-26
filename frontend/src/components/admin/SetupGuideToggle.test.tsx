import { useState } from 'react';
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SetupGuideToggle } from './SetupGuideToggle';

function Harness({ initial = false }: { initial?: boolean }) {
  const [open, setOpen] = useState(initial);
  return (
    <SetupGuideToggle open={open} onOpenChange={setOpen}>
      <p>Guide body</p>
    </SetupGuideToggle>
  );
}

describe('SetupGuideToggle', () => {
  it('hides the guide until the toggle is clicked, and hides it again on the next click', async () => {
    const user = userEvent.setup();
    const { container } = render(<Harness />);
    const toggle = screen.getByRole('button', { name: 'Setup guide' });

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(container.querySelector('.lucide-chevron-down')).toBeInTheDocument();
    expect(screen.queryByText('Guide body')).not.toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    expect(container.querySelector('.lucide-chevron-up')).toBeInTheDocument();
    expect(screen.getByText('Guide body')).toBeInTheDocument();

    await user.click(toggle);

    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByText('Guide body')).not.toBeInTheDocument();
  });

  it('shows the guide when the caller opens it', () => {
    render(<Harness initial />);
    expect(screen.getByText('Guide body')).toBeInTheDocument();
  });
});
