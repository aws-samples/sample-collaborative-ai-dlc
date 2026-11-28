import { StrictMode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen } from '@/test/query';
import { MemoryRouter, Route, Routes } from 'react-router';

vi.mock('@/services/timelineEvents', () => ({
  timelineEventsService: { list: vi.fn() },
}));
vi.mock('@/services/agents', () => ({
  agentsService: { getCurrentExecution: vi.fn() },
}));
vi.mock('@/services/realtime', () => ({
  realtimeService: { on: vi.fn(() => () => {}) },
}));
vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ user: { displayName: 'Ada', email: 'ada@example.com' } }),
}));
vi.mock('@/components/discussion/DiscussionsTab', () => ({ DiscussionsTab: () => null }));
vi.mock('@/components/discussion', () => ({
  DiscussionPanel: () => null,
  useDiscussions: () => null,
}));

import { timelineEventsService } from '@/services/timelineEvents';
import { agentsService } from '@/services/agents';
import { ActivityPanel } from './ActivityPanel';

const listMock = vi.mocked(timelineEventsService.list);

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', { value: state, configurable: true });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange', { bubbles: true }));
  });
}

async function tick(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

function renderPanel({ strict = false } = {}) {
  const tree = (
    <MemoryRouter initialEntries={['/space/p1/sprint/s1']}>
      <Routes>
        <Route
          path="/space/:projectId/sprint/:sprintId"
          element={<ActivityPanel sprintId="s1" onClose={() => {}} />}
        />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <StrictMode>{tree}</StrictMode> : tree);
}

beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  listMock.mockReset().mockResolvedValue([]);
  vi.mocked(agentsService.getCurrentExecution)
    .mockReset()
    .mockResolvedValue({} as never);
});
afterEach(() => {
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  vi.useRealTimers();
});

describe('ActivityPanel timeline polling', () => {
  it('loads on mount and refreshes the timeline every 15 s while visible', async () => {
    renderPanel();
    await tick(0);
    expect(listMock).toHaveBeenCalledTimes(1);
    await tick(15_000);
    expect(listMock).toHaveBeenCalledTimes(2);
  });

  it('pauses while hidden and refreshes once on return', async () => {
    renderPanel();
    await tick(0);
    listMock.mockClear();

    setVisibility('hidden');
    await tick(30_000);
    expect(listMock).not.toHaveBeenCalled();

    setVisibility('visible');
    await tick(0);
    expect(listMock).toHaveBeenCalledTimes(1);
  });
});

// A Radix tab's aria-controls must name a tabpanel that is in the DOM (axe
// aria-valid-attr-value): the active content renders inside TabsContent.
function expectSelectedTabControlsItsPanel(tab: HTMLElement, content: RegExp | string) {
  expect(tab).toHaveAttribute('aria-selected', 'true');
  const panel = document.getElementById(tab.getAttribute('aria-controls') ?? '');
  expect(panel).not.toBeNull();
  expect(panel).toHaveAttribute('role', 'tabpanel');
  expect(panel).toHaveAttribute('aria-labelledby', tab.id);
  expect(panel).toHaveTextContent(content);
}

describe('ActivityPanel tabs', () => {
  it('points the selected tab at a real tabpanel and names the close button', async () => {
    renderPanel();
    await tick(0);
    expectSelectedTabControlsItsPanel(screen.getByRole('tab', { name: /^Agent/ }), /read-only/i);
    expect(screen.getByRole('button', { name: 'Close activity panel' })).toBeInTheDocument();
  });
});

describe('ActivityPanel on a read-only v1 sprint', () => {
  it('shares the timeline and agent reads across a StrictMode double mount', async () => {
    renderPanel({ strict: true });
    await tick(0);
    expect(listMock).toHaveBeenCalledTimes(1);
    expect(agentsService.getCurrentExecution).toHaveBeenCalledTimes(1);
  });

  it('never invites the user to launch an agent on a read-only space', async () => {
    renderPanel();
    await tick(0);
    expect(screen.queryByText(/launch an agent/i)).not.toBeInTheDocument();
    expect(
      screen.getByText(/this v1 space is read-only — agent activity is shown when available/i),
    ).toBeInTheDocument();
  });

  it('opens on the Timeline when the agent has nothing to show and events exist', async () => {
    listMock.mockResolvedValue([
      {
        id: 'e1',
        type: 'artifact_created',
        title: 'Requirement added',
        detail: '',
        userId: 'u1',
        userName: 'Ada',
        timestamp: '2026-05-22T10:00:00Z',
        sprintId: 's1',
      },
    ] as never);
    renderPanel();
    await tick(0);
    expect(screen.getByRole('tab', { name: /Timeline/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText(/No agent output recorded/)).not.toBeInTheDocument();
    // The Agent tab stays one click away.
    expect(screen.getByRole('tab', { name: /Agent/ })).toBeInTheDocument();
  });
});
