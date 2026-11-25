import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from './dialog';

describe('DialogContent', () => {
  it('is announced as modal and offers a 24 px close control', async () => {
    const user = userEvent.setup();
    const onOpenChange = vi.fn();
    render(
      <Dialog open onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogTitle>Rename space</DialogTitle>
          <DialogDescription>Pick a new name.</DialogDescription>
        </DialogContent>
      </Dialog>,
    );

    const dialog = screen.getByRole('dialog', { name: 'Rename space' });
    expect(dialog).toHaveAttribute('aria-modal', 'true');

    const close = screen.getByRole('button', { name: 'Close' });
    expect(close).toHaveClass('h-6', 'w-6', 'inline-flex');
    await user.click(close);
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
