import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  CommandDialog,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from './command';

function renderPalette() {
  return render(
    <CommandDialog open onOpenChange={() => {}}>
      <CommandInput placeholder="Search" />
      <CommandList>
        <CommandGroup heading="Spaces">
          <CommandItem value="retail">retail-v2</CommandItem>
        </CommandGroup>
        <CommandSeparator />
        <CommandGroup heading="Pages">
          <CommandItem value="workflows">Workflows</CommandItem>
        </CommandGroup>
      </CommandList>
    </CommandDialog>,
  );
}

describe('CommandDialog', () => {
  beforeEach(() => {
    Element.prototype.scrollIntoView = vi.fn();
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    };
  });

  // P2-8 (a11y audit): cmdk's own Separator forces role="separator" inside the
  // role="listbox" list, which axe reports as aria-required-children.
  it('keeps the listbox free of separator semantics while still drawing the rule', () => {
    renderPalette();
    const list = screen.getByRole('listbox');
    expect(within(list).queryByRole('separator')).toBeNull();
    const rule = list.querySelector('[cmdk-separator]');
    expect(rule).toHaveAttribute('role', 'none');
    expect(rule).toHaveClass('h-px', 'bg-border');
  });

  it('hides the rule while the list is being filtered', async () => {
    const user = userEvent.setup();
    renderPalette();
    await user.type(screen.getByRole('combobox'), 'work');
    expect(screen.getByRole('listbox').querySelector('[cmdk-separator]')).toBeNull();
  });

  it('is a modal dialog whose close control is at least 24 px', () => {
    renderPalette();
    expect(screen.getByRole('dialog', { name: 'Command palette' })).toHaveAttribute(
      'aria-modal',
      'true',
    );
    expect(screen.getByRole('button', { name: 'Close' })).toHaveClass('h-6', 'w-6');
  });
});
