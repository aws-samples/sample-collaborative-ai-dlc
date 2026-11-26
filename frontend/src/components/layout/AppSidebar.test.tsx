import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen, within } from '@testing-library/react';
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
        <Route path="/space/:projectId/native-intent/:intentId" element={<AppSidebar />} />
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

describe('AppSidebar native discovery routing', () => {
  it('does not expose platform section tabs for a detail with a non-platform backend', () => {
    mockIntentCtx.value = {
      detail: { intent: { id: 'same', projectId: 'p1', executionBackend: 'native' } },
    };
    renderSidebar('/space/p1/intent/same');
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).not.toBeInTheDocument();
  });
  it('does not reuse a context title from an equal UUID in another project', () => {
    mockIntentCtx.value = {
      detail: { intent: { id: 'same', projectId: 'p1', title: 'Wrong project title' } },
    };
    renderSidebar('/space/p2/intent/same');
    expect(screen.queryByText('Wrong project title')).not.toBeInTheDocument();
  });
  const setup = () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2', createdAt: '2024-01-01' },
        latestSprint: null,
        latestIntent: { id: 'same', title: 'Platform same', status: 'RUNNING' },
        nativeIntents: {
          items: [
            {
              id: 'same',
              projectId: 'p1',
              title: 'Native same',
              status: 'READY',
              updatedAt: '2026-09-29T07:00:00Z',
            },
          ],
          loading: false,
          error: null,
          nextCursor: null,
        },
      },
    ];
  };
  it('keeps platform section tabs off native routes even with the same UUID', () => {
    setup();
    renderSidebar('/space/p1/native-intent/same');
    expect(screen.getByText('Native same')).toBeInTheDocument();
    expect(screen.getByText('Workspace ready')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).not.toBeInTheDocument();
    expect(screen.queryByTestId('pinned-selected-intent')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Native same/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
  it('native discovery navigates to status and removes platform tabs', async () => {
    setup();
    renderSidebar('/space/p1/intent/same');
    expect(screen.getByRole('navigation', { name: /intent sections/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Native same/ }));
    expect(screen.queryByRole('navigation', { name: /intent sections/i })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Native same/ })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
  it('does not select equal platform UUIDs from different projects', () => {
    setup();
    mockProjects.projects.push({
      project: { id: 'p2', name: 'Other', kind: 'v2', createdAt: '2024-01-01' },
      latestIntent: { id: 'same', title: 'Other platform', status: 'RUNNING' },
    });
    renderSidebar('/space/p2/intent/same');
    expect(screen.getAllByRole('navigation', { name: /intent sections/i })).toHaveLength(1);
    const row = screen.getByRole('button', { name: /Other platform/ }).parentElement!;
    expect(within(row).getByRole('navigation', { name: /intent sections/i })).toBeInTheDocument();
  });
  it('does not trust a platform META native flag as native discovery', () => {
    mockProjects.projects = [
      {
        project: { id: 'p1', name: 'Space', kind: 'v2' },
        latestIntent: {
          id: 'forged',
          title: 'Forged native',
          status: 'RUNNING',
          executionBackend: 'native',
        },
      },
    ];
    renderSidebar();
    expect(screen.queryByText('Forged native')).not.toBeInTheDocument();
  });
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
        intent: { id: 'int-old', projectId: 'p1', title: 'Historical Intent', status: 'FAILED' },
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
        intent: { id: 'int-1', projectId: 'p1', title: 'Active Intent', status: 'RUNNING' },
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
