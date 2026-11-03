import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route, useLocation } from 'react-router';
import type { PendingQuestion, UnavailableSpace } from '@/services/myWork';

type HookResult = {
  items: PendingQuestion[];
  unavailable: UnavailableSpace[];
  status: 'loading' | 'ready' | 'error';
  error: string | null;
  stale: boolean;
  accessLost: boolean;
  hasMore: boolean;
  loadingMore: boolean;
  refresh: () => void;
  loadMore: () => void;
};
const hook = vi.hoisted(() => ({
  result: null as unknown as HookResult,
  calls: [] as unknown[],
}));
vi.mock('@/hooks/usePendingQuestions', () => ({
  usePendingQuestions: (args: unknown) => {
    hook.calls.push(args);
    return hook.result;
  },
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => ({
    projects: [
      { project: { id: 'p1', name: 'Payments', kind: 'v2' } },
      { project: { id: 'p2', name: 'Data lake', kind: 'v2' } },
      { project: { id: 'legacy', name: 'Legacy', kind: 'v1' } },
    ],
    loading: false,
    error: null,
    refresh: () => {},
    invalidate: () => {},
  }),
}));

import MyWork from './MyWork';

const question = (over: Partial<PendingQuestion> = {}): PendingQuestion => ({
  id: 'i1:q1',
  type: 'question',
  kind: 'question',
  projectId: 'p1',
  projectName: 'Payments',
  intentId: 'i1',
  intentTitle: 'Refund API',
  humanTaskId: 'q1',
  stageInstanceId: 'si-1',
  stageId: 'functional-design',
  phase: 'construction',
  unitSlug: 'refunds',
  sectionIndex: 0,
  summary: 'Which currency rounding rule should refunds use?',
  questionCount: 1,
  checkpoint: null,
  createdAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
  eligibility: { basis: 'space-member', assignment: 'open' },
  target: { view: 'gate', projectId: 'p1', intentId: 'i1', humanTaskId: 'q1' },
  ...over,
});

const setHook = (over: Partial<HookResult> = {}) => {
  hook.result = {
    items: [],
    unavailable: [],
    status: 'ready',
    error: null,
    stale: false,
    accessLost: false,
    hasMore: false,
    loadingMore: false,
    refresh: vi.fn(),
    loadMore: vi.fn(),
    ...over,
  };
};

function Location() {
  const location = useLocation();
  return <div data-testid="location">{location.pathname + location.search}</div>;
}
const renderPage = (entry = '/my-work') =>
  render(
    <MemoryRouter initialEntries={[entry]}>
      <Routes>
        <Route path="/my-work" element={<MyWork />} />
        <Route path="*" element={null} />
      </Routes>
      <Location />
    </MemoryRouter>,
  );

describe('MyWork page', () => {
  beforeAll(() => {
    // Radix Select needs pointer capture and scrolling, which jsdom lacks.
    Object.defineProperties(Element.prototype, {
      hasPointerCapture: { configurable: true, value: () => false },
      setPointerCapture: { configurable: true, value: () => undefined },
      releasePointerCapture: { configurable: true, value: () => undefined },
      scrollIntoView: { configurable: true, value: () => undefined },
    });
  });

  beforeEach(() => {
    hook.calls = [];
    setHook();
  });

  it('shows skeleton rows while loading, not the empty state', () => {
    setHook({ status: 'loading' });
    renderPage();
    expect(screen.getByLabelText('Loading questions')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for your answer')).not.toBeInTheDocument();
  });

  it('shows an error card with Retry and never the empty state', async () => {
    const refresh = vi.fn();
    setHook({ status: 'error', error: 'Could not load your spaces', refresh });
    renderPage();
    expect(screen.getByText("Couldn't load your questions")).toBeInTheDocument();
    expect(screen.getByText('Could not load your spaces')).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for your answer')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(refresh).toHaveBeenCalled();
  });

  it('shows the empty state only when items and unavailable are both empty', () => {
    renderPage();
    expect(screen.getByText('Nothing is waiting for your answer')).toBeInTheDocument();
  });

  it('lists unavailable spaces in a partial alert and still shows items', () => {
    setHook({
      items: [question()],
      unavailable: [
        { projectId: 'p9', projectName: 'Data lake', reason: 'READ_FAILED' },
        { projectId: 'p8', projectName: 'Busy', reason: 'LIMIT_EXCEEDED' },
      ],
    });
    renderPage();
    const alert = screen.getByRole('alert');
    expect(alert).toHaveTextContent("Some spaces couldn't be checked: Data lake.");
    expect(alert).toHaveTextContent('too many active intents to check at once: Busy.');
    expect(
      within(screen.getByRole('list', { name: 'Pending questions' })).getAllByRole('listitem'),
    ).toHaveLength(1);
  });

  it('never says "nothing to do" when spaces could not be checked', () => {
    setHook({ unavailable: [{ projectId: 'p9', projectName: 'Ops', reason: 'READ_FAILED' }] });
    renderPage();
    expect(
      screen.getByText('No questions found in the spaces that could be checked'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting for your answer')).not.toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent('Ops');
  });

  it('labels every item open to eligible members, never assigned to you', () => {
    setHook({
      items: [
        question(),
        question({
          id: 'i2:a1',
          kind: 'approval',
          humanTaskId: 'a1',
          eligibility: { basis: 'space-member', assignment: 'something-new' },
        }),
      ],
    });
    renderPage();
    expect(screen.getAllByText('Open to eligible members')).toHaveLength(2);
    expect(document.body.textContent?.toLowerCase()).not.toContain('assigned to you');
  });

  it('renders space, intent, summary, stage, lane, kind and age', () => {
    const createdAt = new Date(Date.now() - 3 * 3600_000).toISOString();
    setHook({ items: [question({ createdAt, sectionIndex: 1 })] });
    renderPage();
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('Payments');
    expect(row).toHaveTextContent('Refund API');
    expect(row).toHaveTextContent('Which currency rounding rule should refunds use?');
    expect(row).toHaveTextContent('Functional Design · refunds, section 2');
    expect(row).toHaveTextContent('Question');
    const time = row.querySelector('time')!;
    expect(time).toHaveTextContent('3h ago');
    expect(time).toHaveAttribute('dateTime', createdAt);
    expect(time.getAttribute('title')).toBeTruthy();
  });

  it('falls back to the gate labels and "Intent" when fields are missing', () => {
    setHook({
      items: [question({ summary: null, intentTitle: null, kind: 'validation', stageId: null })],
    });
    renderPage();
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('Review required');
    expect(row).toHaveTextContent('Stage review');
    expect(
      screen.getByRole('button', { name: 'Open question in Intent, Payments' }),
    ).toBeInTheDocument();
  });

  it('opens a non-review gate on the intent screen with ?gate=', async () => {
    setHook({
      items: [
        question(),
        question({
          id: 'i2:v1',
          kind: 'validation',
          intentId: 'i2',
          intentTitle: 'Ledger',
          humanTaskId: 'v1',
          target: { view: 'review', projectId: 'p1', intentId: 'i2', humanTaskId: 'v1' },
        }),
      ],
    });
    renderPage();
    await userEvent.click(
      screen.getByRole('button', { name: 'Open question in Refund API, Payments' }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1/intent/i1?gate=q1');
  });

  it('opens a validation gate on its review route', async () => {
    setHook({
      items: [
        question({
          id: 'i2:v1',
          kind: 'validation',
          intentId: 'i2',
          intentTitle: 'Ledger',
          humanTaskId: 'v1',
          target: { view: 'review', projectId: 'p1', intentId: 'i2', humanTaskId: 'v1' },
        }),
      ],
    });
    renderPage();
    await userEvent.click(
      screen.getByRole('button', { name: 'Open question in Ledger, Payments' }),
    );
    expect(screen.getByTestId('location')).toHaveTextContent('/space/p1/intent/i2/review/v1');
  });

  it('reads filters from the URL and passes them to the hook', () => {
    renderPage('/my-work?space=p2&type=approvals');
    expect(hook.calls.at(-1)).toEqual({
      projectId: 'p2',
      kinds: ['approval', 'review-verdict', 'validation'],
    });
  });

  it('filter changes update the URL and the request; v1 spaces are not offered', async () => {
    renderPage();
    expect(hook.calls.at(-1)).toEqual({ projectId: null, kinds: null });
    await userEvent.click(screen.getByRole('combobox', { name: 'Space' }));
    expect(screen.queryByRole('option', { name: 'Legacy' })).not.toBeInTheDocument();
    await userEvent.click(await screen.findByRole('option', { name: 'Payments' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/my-work?space=p1');
    await userEvent.click(screen.getByRole('combobox', { name: 'Type' }));
    await userEvent.click(await screen.findByRole('option', { name: 'Questions' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/my-work?space=p1&type=questions');
    expect(hook.calls.at(-1)).toEqual({ projectId: 'p1', kinds: ['question'] });
    await userEvent.click(screen.getByRole('combobox', { name: 'Space' }));
    await userEvent.click(await screen.findByRole('option', { name: 'All spaces' }));
    expect(screen.getByTestId('location')).toHaveTextContent('/my-work?type=questions');
  });

  it('on lost access shows a notice and drops the space filter', () => {
    setHook({ accessLost: true });
    renderPage('/my-work?space=p1&type=questions');
    expect(screen.getByText(/You no longer have access to that space/)).toBeInTheDocument();
    expect(screen.getByTestId('location')).toHaveTextContent('/my-work?type=questions');
    expect(hook.calls.at(-1)).toEqual({ projectId: null, kinds: ['question'] });
  });

  it('shows Load more while more pages exist', async () => {
    const loadMore = vi.fn();
    setHook({ items: [question()], hasMore: true, loadMore });
    renderPage();
    await userEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(loadMore).toHaveBeenCalled();
  });

  it('keeps the list and says it may be out of date when a refresh fails', () => {
    setHook({ items: [question()], stale: true, error: 'Service unavailable' });
    renderPage();
    expect(screen.getByRole('list', { name: 'Pending questions' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).toHaveTextContent(
      "Couldn't refresh, so this list may be out of date: Service unavailable",
    );
  });
});
