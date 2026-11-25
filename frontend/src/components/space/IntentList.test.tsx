import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, within, act, fireEvent } from '@/test/query';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';

const fixtures = vi.hoisted(() => ({ prefetchHref: vi.fn() }));
vi.mock('@/lib/routePrefetch', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/routePrefetch')>()),
  prefetchHref: fixtures.prefetchHref,
  cancelHrefPrefetch: vi.fn(),
}));

import { IntentList } from './IntentList';
import { installNavIntent } from '@/lib/navIntent';
import { idleCandidates } from '@/lib/idleCandidates';
import { queryClient } from '@/lib/queryClient';
import * as prefetchScheduler from '@/lib/prefetch';
import { qk } from '@/lib/queryKeys';
import type { Intent } from '@/services/intents';

const NOW = Date.parse('2026-11-21T12:00:00Z');
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function intent(id: string, status: Intent['status'], updatedAt: string, extra = {}): Intent {
  return {
    id,
    title: `Intent ${id}`,
    status,
    createdAt: updatedAt,
    updatedAt,
    completedAt: null,
    currentStage: null,
    pendingHumanTaskId: null,
    ...extra,
  } as Intent;
}

const ROWS: Intent[] = [
  intent('cancelled-1', 'CANCELLED', hoursAgo(1), { currentStage: 'requirements-analysis' }),
  intent('running-hung', 'RUNNING', hoursAgo(24 * 120), { currentStage: 'intent-capture' }),
  intent('done-1', 'SUCCEEDED', hoursAgo(2), { currentStage: 'deployment-pipeline' }),
  intent('draft-1', 'DRAFT', hoursAgo(3), { title: 'Title' }),
  intent('question-old', 'WAITING', hoursAgo(24 * 108), {
    pendingHumanTaskId: 'gate-1',
    currentStage: 'requirements-analysis',
  }),
  intent('running-fresh', 'RUNNING', hoursAgo(0.1), { currentStage: 'reverse-engineering' }),
  intent('failed-1', 'FAILED', hoursAgo(24 * 57), { currentStage: 'state-init' }),
  intent('question-new', 'WAITING', hoursAgo(5), { pendingHumanTaskId: 'gate-2' }),
];

function renderList(props: Partial<React.ComponentProps<typeof IntentList>> = {}) {
  const onFilterChange = vi.fn();
  const utils = render(
    <MemoryRouter>
      <IntentList
        projectId="p1"
        intents={ROWS}
        filter="all"
        onFilterChange={onFilterChange}
        now={NOW}
        {...props}
      />
    </MemoryRouter>,
  );
  return { ...utils, onFilterChange };
}

const rowTitles = () =>
  within(screen.getByRole('list', { name: 'Intents' }))
    .getAllByRole('listitem')
    .map((li) => within(li).getByRole('link').textContent);

describe('IntentList ordering (S1)', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
  });

  it('shows needs-input, then failed, then active (including stalled running), then drafts; finished stay collapsed', () => {
    renderList();
    expect(rowTitles()).toEqual([
      'Intent question-new',
      'Intent question-old',
      'Intent failed-1',
      'Intent running-fresh',
      'Intent running-hung',
      'Untitled draft',
    ]);
    expect(screen.queryByText('Intent cancelled-1')).not.toBeInTheDocument();
    const finished = screen.getByRole('button', { name: /2 finished/ });
    expect(finished).toHaveAttribute('aria-expanded', 'false');
  });

  it('reveals finished rows (latest activity first) when the finished group is opened', async () => {
    renderList();
    await userEvent.click(screen.getByRole('button', { name: /2 finished/ }));
    expect(screen.getByText('Intent cancelled-1')).toBeVisible();
    const finishedList = screen.getByRole('list', { name: 'Finished intents' });
    expect(
      within(finishedList)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Intent cancelled-1', 'Intent done-1']);
  });
});

describe('IntentList when nothing is live', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
  });

  it('says so and opens the finished group by default instead of an empty page', () => {
    renderList({ intents: [ROWS[0], ROWS[2]] });
    expect(screen.getByText(/Nothing is running or waiting for you/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /2 finished/ })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(screen.getByRole('list', { name: 'Finished intents' })).toBeInTheDocument();
  });
});

describe('IntentList rows (S2, S5, T1–T3, W9)', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
  });

  it('labels a stuck run as stalled, not running, and keeps the age on a waiting question once its gates are cached', () => {
    // The wait began at the oldest open gate — only the cached detail knows it (R3-5).
    queryClient.setQueryData(qk.intentDetail('p1', 'question-old'), () => ({
      intent: ROWS.find((row) => row.id === 'question-old'),
      gates: [{ humanTaskId: 'gate-1', status: 'pending', createdAt: hoursAgo(24 * 108) }],
      stages: [],
      events: [],
    }));
    renderList();
    const hung = screen.getByRole('link', { name: 'Intent running-hung' }).closest('li')!;
    // Status in the pill, age in the meta line (R5-8).
    expect(hung.querySelector('[data-stalled]')).toHaveTextContent(/^Stalled/);
    expect(within(hung).getByTestId('intent-row-meta')).toHaveTextContent(
      /^Stalled at Intent Capture · Last activity 120 days ago$/,
    );
    expect(hung.querySelector('[data-pulse]')).toBeNull();
    const fresh = screen.getByRole('link', { name: 'Intent running-fresh' }).closest('li')!;
    expect(within(fresh).getByText('Running')).toBeInTheDocument();
    const question = screen.getByRole('link', { name: 'Intent question-old' }).closest('li')!;
    expect(within(question).getByText('Waiting for input')).toBeInTheDocument();
    expect(within(question).getByTestId('intent-row-meta')).toHaveTextContent(/waiting 108 days$/);
    // No detail cached yet: the status without a guessed age.
    const fresh2 = screen.getByRole('link', { name: 'Intent question-new' }).closest('li')!;
    expect(within(fresh2).getByText('Waiting for input')).toBeInTheDocument();
    expect(fresh2).not.toHaveTextContent(/waiting \d/);
  });

  it('shows the human stage name and never the slug; a failed row says where it failed', () => {
    renderList();
    const fresh = screen.getByRole('link', { name: 'Intent running-fresh' }).closest('li')!;
    expect(within(fresh).getByText('Reverse Engineering')).toBeInTheDocument();
    expect(screen.queryByText(/reverse-engineering/)).not.toBeInTheDocument();
    const failed = screen.getByRole('link', { name: 'Intent failed-1' }).closest('li')!;
    expect(within(failed).getByTestId('intent-row-meta')).toHaveTextContent(
      /^Failed at State Init · 57 days ago$/,
    );
    expect(within(failed).getByText('Failed')).toBeInTheDocument();
    const hung = screen.getByRole('link', { name: 'Intent running-hung' }).closest('li')!;
    expect(within(hung).getByTestId('intent-row-meta')).toHaveTextContent(
      /^Stalled at Intent Capture · Last activity 120 days ago$/,
    );
  });

  it('says what waits on a question: the cached gate kinds, or nothing guessed until the detail is known (R3-5)', () => {
    queryClient.setQueryData(qk.intentDetail('p1', 'question-old'), () => ({
      gates: [
        { humanTaskId: 'gate-1', status: 'pending', kind: 'question' },
        { humanTaskId: 'gate-1b', status: 'pending', kind: 'question' },
        { humanTaskId: 'gate-0', status: 'answered', kind: 'approval' },
      ],
    }));
    renderList();
    const known = screen.getByRole('link', { name: 'Intent question-old' }).closest('li')!;
    expect(within(known).getByTestId('intent-row-meta')).toHaveTextContent(
      /^2 questions · Requirements Analysis$/,
    );
    // No stage and no cached gates: nothing to say under the title — no "1 decision" placeholder.
    const unknown = screen.getByRole('link', { name: 'Intent question-new' }).closest('li')!;
    expect(within(unknown).queryByTestId('intent-row-meta')).toBeNull();
    expect(unknown).not.toHaveTextContent(/decision/);
  });

  it('keeps one date grammar with the Spaces inbox: terminal rows carry their verb and an age ("59 days ago"), never an absolute date (R3-6)', async () => {
    renderList();
    await userEvent.click(screen.getByRole('button', { name: /2 finished/ }));
    const done = screen.getByRole('link', { name: 'Intent done-1' }).closest('li')!;
    expect(within(done).getByTestId('intent-row-meta')).toHaveTextContent(/^Completed 2 h ago$/);
    expect(within(done).getByTestId('intent-row-meta').querySelector('time')).toHaveAttribute(
      'dateTime',
      hoursAgo(2),
    );
    const cancelled = screen.getByRole('link', { name: 'Intent cancelled-1' }).closest('li')!;
    expect(within(cancelled).getByTestId('intent-row-meta')).toHaveTextContent(
      /^Cancelled 1 h ago$/,
    );
  });

  it('makes the whole row the link: the overlay sits above the meta and pill, only RowActions stay interactive', () => {
    renderList({ rowActions: () => <button type="button">Row menu</button> });
    const row = screen.getByRole('link', { name: 'Intent running-fresh' }).closest('li')!;
    const link = within(row).getByRole('link');
    expect(link.className).toContain('after:z-10');
    const meta = within(row).getByTestId('intent-row-meta');
    expect(meta.className).toContain('pointer-events-none');
    expect(
      within(row).getByText('Running').closest('span[class*="col-start-2"]')!.className,
    ).toContain('pointer-events-none');
    const actions = within(row).getByRole('button', { name: 'Row menu' }).parentElement!;
    expect(actions.className).toContain('z-20');
  });

  it('renders a placeholder title as an italic "Untitled draft"', () => {
    renderList();
    const draft = screen.getByRole('link', { name: 'Untitled draft' });
    expect(draft.className).toContain('italic');
    expect(screen.queryByText('Title')).not.toBeInTheDocument();
  });

  it('opens Work for a pending question and Overview otherwise', () => {
    renderList();
    expect(screen.getByRole('link', { name: 'Intent question-new' })).toHaveAttribute(
      'href',
      '/space/p1/intent/question-new',
    );
    expect(screen.getByRole('link', { name: 'Intent running-fresh' })).toHaveAttribute(
      'href',
      '/space/p1/intent/running-fresh/observability',
    );
  });

  it('warms the row link through the delegated listener after a hover dwell', () => {
    vi.useFakeTimers();
    fixtures.prefetchHref.mockReset();
    const prefetch = vi
      .spyOn(prefetchScheduler, 'prefetchQuery')
      .mockImplementation(() => undefined);
    const uninstall = installNavIntent(() => ({
      user: { isPlatformAdmin: false },
      currentHref: '/space/p1',
    }));
    try {
      renderList();
      const link = screen.getByRole('link', { name: 'Intent running-fresh' });
      fireEvent.pointerOver(link, { pointerType: 'mouse' });
      act(() => {
        vi.advanceTimersByTime(200);
      });
      expect(fixtures.prefetchHref).toHaveBeenCalledExactlyOnceWith(
        '/space/p1/intent/running-fresh/observability',
        expect.objectContaining({ trigger: 'hover' }),
      );
      // The row has no speculation of its own besides the listener.
      expect(prefetch).not.toHaveBeenCalled();
    } finally {
      uninstall();
      prefetch.mockRestore();
      vi.useRealTimers();
    }
  });

  it('offers at most two visible rows that wait for a human to the idle pass', () => {
    const observed: Element[] = [];
    let trigger: ((entries: Partial<IntersectionObserverEntry>[]) => void) | null = null;
    class FakeObserver {
      constructor(cb: IntersectionObserverCallback) {
        trigger = (entries) => cb(entries as IntersectionObserverEntry[], this as never);
      }
      observe(el: Element) {
        observed.push(el);
      }
      unobserve() {}
      disconnect() {}
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);
    const prefetch = vi
      .spyOn(prefetchScheduler, 'prefetchQuery')
      .mockImplementation(() => undefined);
    try {
      const view = renderList({
        intents: [
          ...ROWS,
          intent('question-3', 'WAITING', hoursAgo(6), { pendingHumanTaskId: 'gate-3' }),
        ],
      });
      expect(observed).toHaveLength(3);
      // Nothing is offered before a row is on screen.
      expect(idleCandidates('page')).toEqual([]);
      act(() => {
        trigger?.(observed.map((target) => ({ target, isIntersecting: true })));
      });
      expect(idleCandidates('page')).toEqual([
        '/space/p1/intent/question-new',
        '/space/p1/intent/question-3',
      ]);
      // useIdleNext owns dispatch; the list never fetches itself.
      expect(prefetch).not.toHaveBeenCalled();
      view.unmount();
      expect(idleCandidates('page')).toEqual([]);
    } finally {
      prefetch.mockRestore();
      vi.unstubAllGlobals();
    }
  });
});

describe('IntentList filters and sort (S1, S6)', () => {
  beforeEach(() => {
    localStorage.clear();
    queryClient.clear();
  });
  afterEach(() => vi.useRealTimers());

  it('offers All / Active / Needs your attention / Finished with counts and reports the choice', async () => {
    const { onFilterChange } = renderList();
    const group = screen.getByRole('group', { name: 'Show intents' });
    expect(within(group).getByRole('radio', { name: 'All' })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    expect(within(group).getByRole('radio', { name: 'Active 4' })).toBeInTheDocument();
    // 2 questions + 1 failed + 1 stalled run: a stuck run needs a human too.
    expect(
      within(group).getByRole('radio', { name: 'Needs your attention 4' }),
    ).toBeInTheDocument();
    expect(within(group).getByRole('radio', { name: 'Finished 2' })).toBeInTheDocument();
    await userEvent.click(within(group).getByRole('radio', { name: 'Finished 2' }));
    expect(onFilterChange).toHaveBeenCalledWith('finished');
  });

  it('shows only the filtered group as a flat list and offers to clear it', () => {
    renderList({ filter: 'failed' });
    expect(rowTitles()).toEqual(['Intent failed-1']);
    expect(screen.getByRole('radio', { name: 'Failed 1' })).toHaveAttribute('aria-checked', 'true');
    expect(screen.queryByRole('button', { name: /finished/ })).not.toBeInTheDocument();
  });

  it('filters by title text and explains an empty result with one way out', async () => {
    renderList();
    await userEvent.type(screen.getByRole('searchbox', { name: 'Filter intents' }), 'nothing-here');
    expect(screen.getByText('No intents match these filters')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(screen.getByRole('link', { name: 'Intent question-new' })).toBeInTheDocument();
  });

  it('exposes the sort as a labelled menu whose current value is never truncated', async () => {
    renderList();
    const sort = screen.getByRole('button', { name: /Sort intents/ });
    expect(sort).toHaveTextContent('Needs your attention first');
    await userEvent.click(sort);
    await userEvent.click(screen.getByRole('menuitemradio', { name: 'Last updated' }));
    expect(screen.getByRole('button', { name: /Sort intents/ })).toHaveTextContent('Last updated');
    expect(rowTitles()[0]).toBe('Intent running-fresh');
    expect(localStorage.getItem('aidlc.intentSort')).toBe('updated');
  });
});
