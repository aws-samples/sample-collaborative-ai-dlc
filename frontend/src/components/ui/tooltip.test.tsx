import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from './tooltip';

function stubViewport(belowSm: boolean) {
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    writable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: query === '(max-width: 639px)' && belowSm,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
}

function renderTooltip(onFocus?: () => void) {
  return render(
    <TooltipProvider delayDuration={0}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button type="button" aria-label="Toggle activity" onFocus={onFocus}>
            A
          </button>
        </TooltipTrigger>
        <TooltipContent>Show activity</TooltipContent>
      </Tooltip>
    </TooltipProvider>,
  );
}

afterEach(() => {
  // @ts-expect-error jsdom has no matchMedia; restore its absence
  delete window.matchMedia;
});

describe('TooltipTrigger', () => {
  it('opens on keyboard focus at sm and above', async () => {
    stubViewport(false);
    renderTooltip();
    await userEvent.tab();
    expect(await screen.findByRole('tooltip', { name: 'Show activity' })).toBeInTheDocument();
  });

  // P2-11 (a11y audit): below sm the popper lands on the neighbouring control and hides its ring.
  it('does not open on keyboard focus below sm, but still calls the consumer onFocus', async () => {
    stubViewport(true);
    const onFocus = vi.fn();
    renderTooltip(onFocus);
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Toggle activity' })).toHaveFocus();
    expect(onFocus).toHaveBeenCalledTimes(1);
    await act(() => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(screen.queryByRole('tooltip')).toBeNull();
  });

  it('still opens on hover below sm', async () => {
    stubViewport(true);
    renderTooltip();
    await userEvent.hover(screen.getByRole('button', { name: 'Toggle activity' }));
    expect(await screen.findByRole('tooltip', { name: 'Show activity' })).toBeInTheDocument();
  });

  it('works without matchMedia (jsdom, old browsers): focus opens the tooltip', async () => {
    renderTooltip();
    await userEvent.tab();
    expect(await screen.findByRole('tooltip', { name: 'Show activity' })).toBeInTheDocument();
  });
});
