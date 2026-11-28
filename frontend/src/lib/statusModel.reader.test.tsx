import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';
import { useRef } from 'react';
import { queryClient } from '@/lib/queryClient';
import { qk } from '@/lib/queryKeys';
import { useIntentStatusReader } from '@/lib/statusModel';
import { render, screen } from '@/test/query';

const summary = {
  id: 'i1',
  status: 'RUNNING',
  createdAt: '2026-11-01T09:00:00Z',
  updatedAt: '2026-11-01T10:00:00Z',
  lastActivityAt: '2026-11-01T10:00:00Z',
} as const;
const detail = { intent: { ...summary, status: 'COMPLETED', updatedAt: '2026-11-01T11:00:00Z' } };

function Reader() {
  const read = useIntentStatusReader();
  return <p data-testid="reader">{read('p1', summary).status.key}</p>;
}

/** Writes the intent detail while it renders, as a provider building its query on mount does. */
function Writer() {
  const wrote = useRef(false);
  if (!wrote.current) {
    wrote.current = true;
    queryClient.setQueryData(qk.intentDetail('p1', 'i1'), detail);
  }
  return null;
}

describe('useIntentStatusReader', () => {
  let consoleError: MockInstance;
  beforeEach(() => {
    consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  });
  afterEach(() => consoleError.mockRestore());

  it("a detail written during another component's render updates the reader afterwards, without a render-phase update", async () => {
    const { rerender, unmount } = render(<Reader />);
    expect(screen.getByTestId('reader')).toHaveTextContent('RUNNING');
    const listeners = () =>
      (queryClient.getQueryCache() as unknown as { listeners: Set<unknown> }).listeners.size;
    const subscribed = listeners();

    rerender(
      <>
        <Reader />
        <Writer />
      </>,
    );

    expect(await screen.findByText('COMPLETED')).toBeInTheDocument();
    expect(
      consoleError.mock.calls.filter((args) =>
        args.some((a) => String(a).includes('while rendering a different component')),
      ),
    ).toEqual([]);

    // Unmounting removes the reader's listener; a queued and a later event log nothing.
    queryClient.setQueryData(qk.intentDetail('p1', 'i1'), {
      intent: { ...detail.intent, updatedAt: '2026-11-01T12:00:00Z' },
    });
    unmount();
    expect(listeners()).toBe(subscribed - 1);
    queryClient.setQueryData(qk.intentDetail('p1', 'i1'), detail);
    await Promise.resolve();
    expect(consoleError).not.toHaveBeenCalled();
  });
});
