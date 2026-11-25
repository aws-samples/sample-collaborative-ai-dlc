import { describe, expect, it } from 'vitest';
import { useState } from 'react';
import { render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { useReturnFocus } from './useReturnFocus';

function ControlledDialog({ restore }: { restore: boolean }) {
  const [open, setOpen] = useState(false);
  const returnFocus = useReturnFocus(open);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <button type="button">Other</button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent onCloseAutoFocus={restore ? returnFocus : undefined}>
          <AlertDialogTitle>Sure?</AlertDialogTitle>
          <AlertDialogDescription>A consequence.</AlertDialogDescription>
          <AlertDialogCancel>Keep</AlertDialogCancel>
          <AlertDialogAction onClick={() => setOpen(false)}>Do it</AlertDialogAction>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

describe('useReturnFocus', () => {
  it('a controlled AlertDialog without a Trigger drops focus to body on close (the bug)', async () => {
    render(<ControlledDialog restore={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Open' }));
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(document.body).toHaveFocus();
  });

  it('hands focus back to the control that opened the dialog, on cancel, Escape and confirm', async () => {
    render(<ControlledDialog restore />);
    const open = screen.getByRole('button', { name: 'Open' });

    await userEvent.click(open);
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Keep' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(open).toHaveFocus());

    await userEvent.click(open);
    await screen.findByRole('alertdialog');
    await userEvent.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(open).toHaveFocus());

    await userEvent.click(open);
    await screen.findByRole('alertdialog');
    await userEvent.click(screen.getByRole('button', { name: 'Do it' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    await waitFor(() => expect(open).toHaveFocus());
  });
});
