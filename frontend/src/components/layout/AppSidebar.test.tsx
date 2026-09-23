import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => ({ isPlatformAdmin: false }),
}));

const mockIntentCtx = vi.hoisted(() => ({ value: null as unknown }));

vi.mock('@/contexts/IntentContext', () => ({
  useIntentOptional: () => mockIntentCtx.value,
}));

const mockProjects = vi.hoisted(() => ({
  projects: [] as unknown[],
  loading: false,
  refresh: vi.fn(),
}));

vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectsCache: () => mockProjects,
  projectLastActivityAt: () => null,
  useProjectCache: () => ({ project: null }),
}));

vi.mock('@/components/CreateProjectModal', () => ({
  CreateProjectModal: () => null,
}));

import { AppSidebar } from './AppSidebar';

function renderSidebar(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/dashboard" element={<AppSidebar />} />
        <Route path="/space/:projectId" element={<AppSidebar />} />
        <Route path="/space/:projectId/intent/:intentId" element={<AppSidebar />} />
        <Route path="/space/:projectId/intent/:intentId/observability" element={<AppSidebar />} />
        <Route path="/space/:projectId/intent/:intentId/graph" element={<AppSidebar />} />
        <Route path="*" element={<AppSidebar />} />
      </Routes>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  mockProjects.projects = [];
  mockIntentCtx.value = null;
  localStorage.clear();
});

describe('AppSidebar active-work section', () => {
  it('shows dynamic filter label (default "Active"), not a clickable link', () => {
    renderSidebar();
    // The section header should contain the "Active" label (default filter)
    const label = screen.getByLabelText(/active work filter/i);
    expect(label).toBeInTheDocument();
    expect(label.tagName).toBe('DIV'); // non-navigating element
    expect(label).toHaveTextContent('Active');
  });

  it('reflects the stored filter label', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    renderSidebar();
    const label = screen.getByLabelText(/active work filter/i);
    expect(label).toHaveTextContent('Needs attention');
  });

  it('uses latestIntent status for v2 projects', () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'V2 Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Build feature', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    renderSidebar();
    const projectBtn = screen.getByTitle('V2 Space — Agent running');
    expect(projectBtn).toBeInTheDocument();
  });

  it('no longer shows waiting title on v1 Space row (attention surfaced at Intent level)', () => {
    mockProjects.projects = [
      {
        project: { id: 'p2', name: 'V1 Project', kind: 'v1', createdAt: '2024-01-01' },
        latestSprint: {
          id: 's1',
          name: 'Sprint 1',
          phase: 'INCEPTION',
          currentAgentStatus: 'waiting',
        },
        latestIntent: null,
        lastIntentActivityAt: null,
        activity: { inProgress: 0, attention: 0 },
      },
    ];
    renderSidebar();
    const projectBtn = screen.getByTitle('V1 Project');
    expect(projectBtn).toBeInTheDocument();
  });

  it('counts and displays every matching Intent in one v2 Space', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      { id: 'int-1', title: 'Waiting Intent One', status: 'WAITING' },
      { id: 'int-2', title: 'Waiting Intent Two', status: 'WAITING' },
      { id: 'int-3', title: 'Waiting Intent Three', status: 'WAITING' },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Busy Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 3, attention: 3 },
      },
    ];

    renderSidebar();

    expect(screen.getByLabelText(/active work filter/i)).toHaveTextContent('Needs attention3');
    expect(screen.getByText('Waiting Intent One')).toBeInTheDocument();
    expect(screen.getByText('Waiting Intent Two')).toBeInTheDocument();
    expect(screen.getByText('Waiting Intent Three')).toBeInTheDocument();
  });

  it('counts only Intents matching the selected filter', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = [
      { id: 'int-1', title: 'Waiting Intent', status: 'WAITING' },
      { id: 'int-2', title: 'Failed Intent One', status: 'FAILED' },
      { id: 'int-3', title: 'Failed Intent Two', status: 'FAILED' },
      { id: 'int-4', title: 'Running Intent', status: 'RUNNING' },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Mixed Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[3],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 4, attention: 3 },
      },
    ];

    renderSidebar();

    expect(screen.getByLabelText(/active work filter/i)).toHaveTextContent('Needs attention3');
    expect(screen.getByText('Waiting Intent')).toBeInTheDocument();
    expect(screen.getByText('Failed Intent One')).toBeInTheDocument();
    expect(screen.getByText('Failed Intent Two')).toBeInTheDocument();
    expect(screen.queryByText('Running Intent')).not.toBeInTheDocument();
  });

  it('shows at most five matching Intents per Space without an overflow control', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = Array.from({ length: 6 }, (_, index) => ({
      id: `int-${index + 1}`,
      title: `Waiting Intent ${index + 1}`,
      status: 'WAITING',
    }));
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Overflow Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 6, attention: 6 },
      },
    ];

    renderSidebar();

    for (let index = 1; index <= 5; index++) {
      expect(screen.getByText(`Waiting Intent ${index}`)).toBeInTheDocument();
    }
    expect(screen.queryByText('Waiting Intent 6')).not.toBeInTheDocument();
    expect(screen.queryByText(/view all/i)).not.toBeInTheDocument();
  });

  it('sorts matching Intents by recent activity before applying the five-row cap', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    const intents = [
      {
        id: 'waiting-1',
        title: 'Oldest waiting Intent',
        status: 'WAITING',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
      {
        id: 'waiting-2',
        title: 'Waiting Intent Two',
        status: 'WAITING',
        updatedAt: '2026-01-02T00:00:00.000Z',
      },
      {
        id: 'waiting-3',
        title: 'Waiting Intent Three',
        status: 'WAITING',
        updatedAt: '2026-01-03T00:00:00.000Z',
      },
      {
        id: 'waiting-4',
        title: 'Waiting Intent Four',
        status: 'WAITING',
        updatedAt: '2026-01-04T00:00:00.000Z',
      },
      {
        id: 'waiting-5',
        title: 'Waiting Intent Five',
        status: 'WAITING',
        updatedAt: '2026-01-05T00:00:00.000Z',
      },
      {
        id: 'running-new',
        title: 'Newest running Intent',
        status: 'RUNNING',
        updatedAt: '2026-02-01T00:00:00.000Z',
      },
    ];
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Status-grouped Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[5],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 6, attention: 5 },
      },
    ];

    renderSidebar();

    expect(screen.getByText('Newest running Intent')).toBeInTheDocument();
    expect(screen.queryByText('Oldest waiting Intent')).not.toBeInTheDocument();
  });

  it('keeps a selected matching Intent visible when it falls beyond the five-row cap', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'attention');
    const intents = Array.from({ length: 6 }, (_, index) => ({
      id: `int-${index + 1}`,
      title: `Waiting Intent ${index + 1}`,
      status: 'WAITING',
    }));
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Overflow Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: intents[0],
        intents,
        lastIntentActivityAt: null,
        activity: { inProgress: 6, attention: 6 },
      },
    ];
    mockIntentCtx.value = {
      detail: {
        intent: intents[5],
      },
    };

    renderSidebar('/space/p1/intent/int-6/observability');

    expect(screen.getByText('Waiting Intent 6')).toBeInTheDocument();
    expect(screen.queryByText('Waiting Intent 5')).not.toBeInTheDocument();
    expect(screen.queryByTestId('pinned-selected-intent')).not.toBeInTheDocument();
    expect(screen.getByRole('navigation', { name: /intent sections/i })).toBeInTheDocument();
  });
});

describe('AppSidebar IntentSectionTabs density', () => {
  it('renders dense section tabs when intent is selected', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Intent A', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    renderSidebar('/space/p1/intent/int-1/observability');
    const nav = screen.getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
    expect(nav.className).toContain('py-1');
    expect(nav.className).toContain('gap-px');
    const overviewBtn = within(nav).getByRole('button', { name: /overview/i });
    expect(overviewBtn.className).toContain('py-[3px]');
  });
});

describe('AppSidebar pinned historical Intent', () => {
  const setupHistorical = () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space One', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-latest', title: 'Latest Intent', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    mockIntentCtx.value = {
      detail: {
        intent: { id: 'int-old', title: 'Historical Intent', status: 'FAILED' },
      },
    };
  };

  it('shows a pinned row with subtabs for a URL-selected intent not in filtered list', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const pinned = screen.getByTestId('pinned-selected-intent');
    expect(pinned).toBeInTheDocument();
    expect(pinned).toHaveTextContent('Historical Intent');
    const nav = within(pinned).getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
  });

  it('shows a compact "Historical" label on the pinned row', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const pinned = screen.getByTestId('pinned-selected-intent');
    expect(pinned).toHaveTextContent('Historical');
  });

  it('does NOT show a Pin icon on the historical row', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const pinned = screen.getByTestId('pinned-selected-intent');
    expect(pinned.querySelector('.lucide-pin')).toBeNull();
  });

  it('does NOT show a status-derived red error icon (XCircle) on the historical row', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const pinned = screen.getByTestId('pinned-selected-intent');
    // XCircle would appear for FAILED status via IterationStatusIcon; should NOT be here
    expect(pinned.querySelector('.lucide-x-circle')).toBeNull();
  });

  it('uses a neutral History icon instead of a status icon', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const pinned = screen.getByTestId('pinned-selected-intent');
    expect(pinned.querySelector('.lucide-history')).toBeInTheDocument();
  });

  it('has an accessible title explaining the historical context', () => {
    setupHistorical();
    renderSidebar('/space/p1/intent/int-old/observability');
    const pinned = screen.getByTestId('pinned-selected-intent');
    const btn = within(pinned).getByTitle(/historical/i);
    expect(btn).toBeInTheDocument();
  });

  it('does NOT duplicate when the selected intent is already in the filtered list', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space One', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Active Intent', status: 'RUNNING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 0 },
      },
    ];
    mockIntentCtx.value = {
      detail: {
        intent: { id: 'int-1', title: 'Active Intent', status: 'RUNNING' },
      },
    };
    renderSidebar('/space/p1/intent/int-1/observability');
    expect(screen.queryByTestId('pinned-selected-intent')).not.toBeInTheDocument();
    const nav = screen.getByRole('navigation', { name: /intent sections/i });
    expect(nav).toBeInTheDocument();
  });
});

describe('AppSidebar Space-level attention removal', () => {
  it('does not show MessageCircleQuestion icon on Space row for waiting v2 project', () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Waiting Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Waiting Intent', status: 'WAITING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar();
    const spaceBtn = screen.getByTitle('Waiting Space');
    expect(spaceBtn).toBeInTheDocument();
    expect(spaceBtn.querySelector('.lucide-message-circle-question-mark')).toBeNull();
  });

  it('still shows waiting icon on Intent iteration rows', () => {
    localStorage.setItem('aidlc-sidebar-iterations-filter', 'active');
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Waiting Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'int-1', title: 'Waiting Intent', status: 'WAITING' },
        lastIntentActivityAt: null,
        activity: { inProgress: 1, attention: 1 },
      },
    ];
    renderSidebar();
    const allQuestionIcons = document.querySelectorAll('.lucide-message-circle-question-mark');
    const spaceBtn = screen.getByTitle('Waiting Space');
    const spaceHasIcon = spaceBtn.querySelector('.lucide-message-circle-question-mark');
    expect(spaceHasIcon).toBeNull();
    expect(allQuestionIcons.length).toBeGreaterThan(0);
  });
});
