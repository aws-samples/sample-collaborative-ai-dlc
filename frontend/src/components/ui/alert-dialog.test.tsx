import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from './alert-dialog';

function renderDialog(variant?: 'default' | 'destructive') {
  return render(
    <AlertDialog open>
      <AlertDialogContent>
        <AlertDialogTitle>Delete rule?</AlertDialogTitle>
        <AlertDialogDescription>This cannot be undone.</AlertDialogDescription>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant={variant}>Delete</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>,
  );
}

describe('AlertDialogAction', () => {
  it('variant="destructive" applies the destructive styles and leaves initial focus on Cancel', async () => {
    renderDialog('destructive');
    const action = screen.getByRole('button', { name: 'Delete' });
    expect(action).toHaveClass('bg-destructive', 'text-destructive-foreground');
    expect(action).not.toHaveClass('bg-primary');
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
    });
  });

  it('is announced as modal (P2-12)', () => {
    renderDialog();
    expect(screen.getByRole('alertdialog', { name: 'Delete rule?' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
  });
});
