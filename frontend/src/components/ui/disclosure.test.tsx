import { useEffect, useState } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Disclosure } from './disclosure';

function Probe({ onMount }: { onMount: () => void }) {
  useEffect(() => {
    onMount();
  }, [onMount]);
  return <div>Probe body</div>;
}

describe('Disclosure', () => {
  it('renders a real button whose accessible name is the title plus the count', () => {
    render(
      <Disclosure title="Diagnostics" count={6}>
        body
      </Disclosure>,
    );
    const trigger = screen.getByRole('button', { name: 'Diagnostics (6)' });
    expect(trigger.tagName).toBe('BUTTON');
  });

  // P2-10 (a11y audit): the trigger's own box was 16–20 px tall in row/inline rows.
  it.each(['row', 'card', 'section', 'inline'] as const)(
    'keeps the %s trigger at least 24 px tall',
    (variant) => {
      render(
        <Disclosure title="Technical details" variant={variant}>
          body
        </Disclosure>,
      );
      expect(screen.getByRole('button', { name: 'Technical details' })).toHaveClass('min-h-6');
    },
  );

  it('toggles aria-expanded on click and on keyboard', async () => {
    const user = userEvent.setup();
    render(<Disclosure title="Logs">body</Disclosure>);
    const trigger = screen.getByRole('button', { name: 'Logs' });
    await user.click(trigger);
    expect(trigger).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('body')).toBeVisible();
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
  });

  it('does not mount children while closed (default)', async () => {
    const user = userEvent.setup();
    const onMount = vi.fn();
    render(
      <Disclosure title="Lazy">
        <Probe onMount={onMount} />
      </Disclosure>,
    );
    expect(onMount).not.toHaveBeenCalled();
    expect(screen.queryByText('Probe body')).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Lazy' }));
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Probe body')).toBeInTheDocument();
  });

  it('forceMount keeps children mounted (hidden) while closed', () => {
    const onMount = vi.fn();
    render(
      <Disclosure title="Eager" forceMount>
        <Probe onMount={onMount} />
      </Disclosure>,
    );
    expect(onMount).toHaveBeenCalledTimes(1);
    expect(screen.getByText('Probe body')).not.toBeVisible();
  });

  it('shows summary and status in the collapsed header, outside the button name', () => {
    render(
      <Disclosure
        title="Graph enrichment"
        summary="Graph enrichment · On"
        status={<span data-testid="status">Configured</span>}
      >
        body
      </Disclosure>,
    );
    expect(screen.getByText('Graph enrichment · On')).toBeVisible();
    expect(screen.getByTestId('status')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Graph enrichment' })).toBeInTheDocument();
  });

  it('supports defaultOpen and the controlled open/onOpenChange pair', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure title="Open by default" defaultOpen>
        first
      </Disclosure>,
    );
    expect(screen.getByRole('button', { name: 'Open by default' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );

    function Controlled() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <Disclosure title="Controlled" open={open} onOpenChange={setOpen}>
            second
          </Disclosure>
          <output>{open ? 'open' : 'closed'}</output>
        </>
      );
    }
    render(<Controlled />);
    await user.click(screen.getByRole('button', { name: 'Controlled' }));
    expect(screen.getByRole('status')).toHaveTextContent('open');
  });

  it('keeps actions as sibling controls so they do not toggle the panel', () => {
    const onAction = vi.fn();
    render(
      <Disclosure title="With action" actions={<button onClick={onAction}>Retry</button>}>
        body
      </Disclosure>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(onAction).toHaveBeenCalledTimes(1);
    expect(screen.getByRole('button', { name: 'With action' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
  });

  it('wraps the trigger in a heading only when headingLevel is set', () => {
    render(
      <>
        <Disclosure variant="card" title="Card" headingLevel={3}>
          c
        </Disclosure>
        <Disclosure title="Row">r</Disclosure>
      </>,
    );
    expect(screen.getByRole('heading', { level: 3, name: 'Card' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Row' })).toBeNull();
  });

  // A nested Disclosure (Technical details inside an open card) must point its
  // own chevron by its own state, not the ancestor's.
  it('rotates the chevron by its own open state, not an open ancestor', async () => {
    const user = userEvent.setup();
    render(
      <Disclosure variant="card" title="Outer" defaultOpen>
        <Disclosure variant="inline" title="Technical details">
          inner
        </Disclosure>
      </Disclosure>,
    );
    const chevronOf = (name: string) =>
      screen
        .getByRole('button', { name })
        .closest('[data-slot=disclosure-header]')!
        .querySelector('svg')!;
    expect(chevronOf('Outer')).toHaveAttribute('data-open', 'true');
    expect(chevronOf('Technical details')).not.toHaveAttribute('data-open');
    await user.click(screen.getByRole('button', { name: 'Technical details' }));
    expect(chevronOf('Technical details')).toHaveAttribute('data-open', 'true');
  });
});
