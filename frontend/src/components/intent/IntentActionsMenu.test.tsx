import { describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@/test/query';
import userEvent from '@testing-library/user-event';
import type { IntentStatus } from '@/services/intents';
import { IntentActionsMenu, type IntentActionsMenuProps } from './IntentActionsMenu';

function renderMenu(props: Partial<IntentActionsMenuProps> = {}) {
  const handlers = {
    onConfiguration: vi.fn(),
    onReshape: vi.fn(),
    onExport: vi.fn(),
    onAudit: vi.fn(),
    onCancel: vi.fn(() => Promise.resolve()),
    onDelete: vi.fn(() => Promise.resolve()),
  };
  const utils = render(
    <IntentActionsMenu
      intent={{ status: 'WAITING', title: 'Cart quantity stepper' }}
      {...handlers}
      {...props}
    />,
  );
  return { ...utils, handlers };
}

const openMenu = async () => {
  await userEvent.click(screen.getByRole('button', { name: 'Intent actions' }));
  return screen.findByRole('menu');
};

const menuItemNames = () => screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());

describe('IntentActionsMenu', () => {
  it('is one labelled menu with the shared items in a stable order', async () => {
    renderMenu();
    await openMenu();
    expect(menuItemNames()).toEqual([
      'Intent configuration',
      'Reshape remaining stages',
      'Download workspace',
      'Audit',
      'Cancel run',
      'Delete intent',
    ]);
  });

  it('renders only the items whose handler is provided', async () => {
    renderMenu({ onReshape: undefined, onExport: undefined, onDelete: undefined });
    await openMenu();
    expect(menuItemNames()).toEqual(['Intent configuration', 'Audit', 'Cancel run']);
  });

  it('runs the plain actions without a confirmation', async () => {
    const { handlers } = renderMenu();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Intent configuration' }));
    expect(handlers.onConfiguration).toHaveBeenCalledTimes(1);
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Audit' }));
    expect(handlers.onAudit).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it.each<IntentStatus>(['WAITING', 'CREATED'])(
    'offers Cancel run when the backend accepts a cancel (%s)',
    async (status) => {
      renderMenu({ intent: { status, title: 'Cart quantity stepper' } });
      await openMenu();
      expect(screen.getByRole('menuitem', { name: 'Cancel run' })).toBeInTheDocument();
    },
  );

  it('FAILED: the cancel only closes the run, so the item says so', async () => {
    renderMenu({ intent: { status: 'FAILED', title: 'Cart quantity stepper' } });
    await openMenu();
    expect(screen.getByRole('menuitem', { name: 'Close failed run' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Cancel run' })).toBeNull();
  });

  it.each<IntentStatus>(['SUCCEEDED', 'CANCELLED', 'DRAFT'])(
    'hides Cancel run once there is nothing left to cancel (%s)',
    async (status) => {
      renderMenu({ intent: { status, title: 'Cart quantity stepper' } });
      await openMenu();
      expect(screen.queryByRole('menuitem', { name: /Cancel run/ })).toBeNull();
    },
  );

  it('RUNNING (including stalled): keeps Cancel run visible but disabled, with the reason', async () => {
    const { handlers } = renderMenu({
      intent: { status: 'RUNNING', title: 'Cart quantity stepper' },
    });
    await openMenu();
    const item = screen.getByRole('menuitem', { name: /Cancel run/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('The engine still reports this run as running');
    await userEvent.click(item);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(handlers.onCancel).not.toHaveBeenCalled();
  });

  it('Cancel run: confirms in an AlertDialog that names the intent, focuses the safe choice, and only proceeds on confirm', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm');
    const { handlers } = renderMenu();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));

    const dialog = await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
    expect(dialog).toHaveTextContent('Cart quantity stepper');
    expect(dialog).toHaveTextContent(/pending questions/i);
    const keep = screen.getByRole('button', { name: 'Keep run' });
    await waitFor(() => expect(keep).toHaveFocus());
    expect(handlers.onCancel).not.toHaveBeenCalled();

    await userEvent.click(keep);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(handlers.onCancel).not.toHaveBeenCalled();

    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
    const confirm = await screen.findByRole('button', { name: 'Cancel run' });
    expect(confirm).toHaveClass('bg-destructive');
    await userEvent.click(confirm);
    expect(handlers.onCancel).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(confirmSpy).not.toHaveBeenCalled();
  });

  it('Close failed run: the dialog explains that the failed run is closed, then cancels', async () => {
    const { handlers } = renderMenu({ intent: { status: 'FAILED', title: 'cf2-express' } });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Close failed run' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Close this failed run?' });
    expect(dialog).toHaveTextContent(/failed run "cf2-express" will be closed/i);
    await userEvent.click(screen.getByRole('button', { name: 'Close failed run' }));
    await waitFor(() => expect(handlers.onCancel).toHaveBeenCalledTimes(1));
  });

  it('Delete intent: destructive AlertDialog naming the intent; proceeds only on confirm', async () => {
    const { handlers } = renderMenu();
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this intent?' });
    expect(dialog).toHaveTextContent('Cart quantity stepper');
    expect(dialog).toHaveTextContent(/cannot be undone/i);
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keep intent' })).toHaveFocus());
    const confirm = screen.getByRole('button', { name: 'Delete intent' });
    expect(confirm).toHaveClass('bg-destructive');
    await userEvent.click(confirm);
    expect(handlers.onDelete).toHaveBeenCalledTimes(1);
  });

  it('hides Delete while the run is RUNNING (the API refuses it)', async () => {
    renderMenu({ intent: { status: 'RUNNING', title: 'Cart quantity stepper' } });
    await openMenu();
    expect(screen.queryByRole('menuitem', { name: 'Delete intent' })).toBeNull();
  });

  it('keeps the dialog open and busy while the confirmed action is pending', async () => {
    let resolve!: () => void;
    const onCancel = vi.fn(() => new Promise<void>((r) => (resolve = r)));
    renderMenu({ onCancel });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
    expect(screen.getByRole('button', { name: 'Cancel run' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.getByRole('button', { name: 'Keep run' })).toBeDisabled();
    resolve();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('closes the dialog when the action rejects, leaving the error to the caller', async () => {
    const onDelete = vi.fn(() => Promise.reject(new Error('Forbidden')));
    renderMenu({ onDelete });
    await openMenu();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Delete intent' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it('disables Download workspace with a reason when export is unavailable', async () => {
    renderMenu({ exportDisabledReason: 'Not available before the workflow starts' });
    await openMenu();
    const item = screen.getByRole('menuitem', { name: /Download workspace/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Not available before the workflow starts');
  });

  it('keeps Reshape in the menu, disabled with the reason, when the run state forbids it', async () => {
    const { handlers } = renderMenu({
      intent: { status: 'RUNNING', title: 'Cart quantity stepper' },
      reshapeDisabledReason: 'Only while the run is waiting or has failed',
    });
    await openMenu();
    const item = screen.getByRole('menuitem', { name: /Reshape remaining stages/ });
    expect(item).toHaveAttribute('aria-disabled', 'true');
    expect(item).toHaveTextContent('Only while the run is waiting or has failed');
    await userEvent.click(item);
    expect(handlers.onReshape).not.toHaveBeenCalled();
  });

  it('accepts extra consumer items before the destructive group', async () => {
    renderMenu({
      extraItems: (
        <IntentActionsMenu.Item onSelect={() => {}}>Start a new intent</IntentActionsMenu.Item>
      ),
    });
    await openMenu();
    const names = menuItemNames();
    expect(names.indexOf('Start a new intent')).toBeGreaterThan(names.indexOf('Audit'));
    expect(names.indexOf('Start a new intent')).toBeLessThan(names.indexOf('Cancel run'));
  });

  describe('focus and modality (WCAG 2.4.3)', () => {
    it('returns focus to the "Intent actions" trigger when a confirmation is dismissed', async () => {
      renderMenu();
      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
      await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
      await userEvent.click(screen.getByRole('button', { name: 'Keep run' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Intent actions' })).toHaveFocus(),
      );

      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Delete intent' }));
      await screen.findByRole('alertdialog', { name: 'Delete this intent?' });
      await userEvent.keyboard('{Escape}');
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Intent actions' })).toHaveFocus(),
      );
    });

    it('returns focus to the trigger after a confirmed action too', async () => {
      renderMenu();
      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
      await userEvent.click(await screen.findByRole('button', { name: 'Cancel run' }));
      await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
      await waitFor(() =>
        expect(screen.getByRole('button', { name: 'Intent actions' })).toHaveFocus(),
      );
    });

    it('opens a plain action only after the menu has closed and refocused its trigger', async () => {
      const onConfiguration = vi.fn(() => {
        expect(screen.queryByRole('menu')).toBeNull();
        expect(screen.getByRole('button', { name: 'Intent actions' })).toHaveFocus();
      });
      renderMenu({ onConfiguration });
      await openMenu();
      await userEvent.click(screen.getByRole('menuitem', { name: 'Intent configuration' }));
      expect(onConfiguration).toHaveBeenCalledTimes(1);
    });

    it('is a non-modal menu, so only the confirmation dialog hides the page from assistive tech', async () => {
      const { container: page } = renderMenu();
      await openMenu();
      // The open menu must not aria-hide the page: its own cleanup would otherwise
      // race the dialog's and leave the page exposed (audit P1-4).
      expect(page).not.toHaveAttribute('aria-hidden');
      await userEvent.click(screen.getByRole('menuitem', { name: 'Cancel run' }));
      await screen.findByRole('alertdialog', { name: 'Cancel this run?' });
      await waitFor(() => expect(page).toHaveAttribute('aria-hidden', 'true'));
      await userEvent.click(screen.getByRole('button', { name: 'Keep run' }));
      await waitFor(() => expect(page).not.toHaveAttribute('aria-hidden'));
    });
  });
});
