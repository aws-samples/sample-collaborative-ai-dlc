import { act, fireEvent, render, screen } from '@/test/query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CollaborationStatusAlert, CONNECTING_HINT_AFTER_MS } from './CollaborationStatusAlert';

describe('CollaborationStatusAlert', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('renders nothing while collaboration is synced', () => {
    const { container } = render(
      <CollaborationStatusAlert connection="synced" onRetry={vi.fn()} context="answers" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it('stays quiet for a short connection and hints once it takes longer', () => {
    vi.useFakeTimers();
    const { container } = render(
      <CollaborationStatusAlert connection="connecting" onRetry={vi.fn()} context="answers" />,
    );
    act(() => {
      vi.advanceTimersByTime(CONNECTING_HINT_AFTER_MS - 1);
    });
    expect(container).toBeEmptyDOMElement();

    act(() => {
      vi.advanceTimersByTime(1);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to live collaboration…');
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('never shows the connecting hint when sync arrives first', () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <CollaborationStatusAlert connection="connecting" onRetry={vi.fn()} context="draft" />,
    );
    rerender(<CollaborationStatusAlert connection="synced" onRetry={vi.fn()} context="draft" />);
    act(() => {
      vi.advanceTimersByTime(CONNECTING_HINT_AFTER_MS * 2);
    });
    expect(container).toBeEmptyDOMElement();
  });

  it.each([
    ['answers', "Answers can't be submitted until it reconnects."],
    ['draft', "Edits to this draft can't be saved until it reconnects."],
  ] as const)('warns with the %s consequence and a retry action', (context, sentence) => {
    render(
      <CollaborationStatusAlert connection="unavailable" onRetry={vi.fn()} context={context} />,
    );

    const alert = screen.getByRole('alert');
    expect(alert).toHaveAttribute('data-tone', 'warning');
    expect(alert).toHaveTextContent('Live collaboration is unavailable');
    expect(alert).toHaveTextContent(sentence);
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeEnabled();
  });

  // W36 §2 P2: at 390 px the message sat in a 190 px column beside the button.
  it('stacks Retry now under the message below the sm breakpoint', () => {
    render(
      <CollaborationStatusAlert connection="unavailable" onRetry={vi.fn()} context="answers" />,
    );
    const alert = screen.getByRole('alert');
    expect(alert).toHaveClass('max-sm:flex-wrap');
    const action = screen.getByRole('button', { name: 'Retry now' }).parentElement!;
    expect(action).toBe(alert.lastElementChild);
    expect(alert.className).toMatch(/max-sm:\[&>div:last-child\]:basis-full/);
    expect(alert.className).toMatch(/max-sm:\[&>div:last-child\]:pl-7/);
  });

  it('calls onRetry when Retry now is pressed', () => {
    const onRetry = vi.fn();
    render(
      <CollaborationStatusAlert connection="unavailable" onRetry={onRetry} context="answers" />,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it('keeps the warning with a busy Retry button while the retry reconnects', () => {
    const onRetry = vi.fn();
    const view = (connection: 'connecting' | 'synced' | 'unavailable') => (
      <CollaborationStatusAlert connection={connection} onRetry={onRetry} context="answers" />
    );
    const { container, rerender } = render(view('unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));

    rerender(view('connecting'));
    expect(screen.getByRole('alert')).toHaveTextContent('Live collaboration is unavailable');
    const busy = screen.getByRole('button', { name: 'Retry now' });
    expect(busy).toBeDisabled();
    expect(busy).toHaveAttribute('aria-busy', 'true');

    rerender(view('unavailable'));
    expect(screen.getByRole('button', { name: 'Retry now' })).toBeEnabled();

    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    rerender(view('connecting'));
    rerender(view('synced'));
    expect(container).toBeEmptyDOMElement();
    expect(onRetry).toHaveBeenCalledTimes(2);
  });

  it('does not treat a later connection as a retry in progress', () => {
    vi.useFakeTimers();
    const view = (connection: 'connecting' | 'synced' | 'unavailable') => (
      <CollaborationStatusAlert connection={connection} onRetry={vi.fn()} context="answers" />
    );
    const { container, rerender } = render(view('unavailable'));
    fireEvent.click(screen.getByRole('button', { name: 'Retry now' }));
    rerender(view('connecting'));
    rerender(view('synced'));

    // A later drop is an ordinary reconnect: quiet first, then the subtle hint.
    rerender(view('connecting'));
    expect(container).toBeEmptyDOMElement();
    act(() => {
      vi.advanceTimersByTime(CONNECTING_HINT_AFTER_MS);
    });
    expect(screen.getByRole('status')).toHaveTextContent('Connecting to live collaboration…');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});
