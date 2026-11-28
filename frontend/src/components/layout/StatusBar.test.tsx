import { act, render, screen } from '@/test/query';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const realtimeState = vi.hoisted(() => ({
  status: 'idle',
  handlers: new Set<(status: string) => void>(),
}));

vi.mock('@/services/realtime', () => ({
  realtimeService: {
    getStatus: () => realtimeState.status,
    onStatusChange: (handler: (status: string) => void) => {
      realtimeState.handlers.add(handler);
      handler(realtimeState.status);
      return () => realtimeState.handlers.delete(handler);
    },
  },
}));

const mockIntentCtx = vi.hoisted(() => ({ value: null as unknown }));
vi.mock('@/contexts/IntentContext', () => ({
  useIntentOptional: () => mockIntentCtx.value,
}));

const mockProjects = vi.hoisted(() => ({ projects: [] as { project: unknown }[] }));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: (projectId: string | null) => ({
    project:
      mockProjects.projects.find((entry) => (entry.project as { id: string }).id === projectId)
        ?.project ?? null,
  }),
}));

import { MemoryRouter, Route, Routes } from 'react-router';
import { StatusBar, useReportCollaboration } from './StatusBar';
import { CollaborationStatusAlert } from '@/components/collab/CollaborationStatusAlert';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/space/:projectId" element={<StatusBar />} />
        <Route path="/space/:projectId/intent/:intentId" element={<StatusBar />} />
        <Route path="/space/:projectId/intent/:intentId/audit" element={<StatusBar />} />
        <Route path="/space/:projectId/sprint/:sprintId" element={<StatusBar />} />
        <Route path="*" element={<StatusBar />} />
      </Routes>
    </MemoryRouter>,
  );
}

function intentDetail(id: string, status: string) {
  return { detail: { intent: { id, status } } };
}

function CollaborativePage({
  connection,
}: {
  connection: 'connecting' | 'synced' | 'unavailable';
}) {
  useReportCollaboration(connection);
  return null;
}

function setStatus(status: string) {
  act(() => {
    realtimeState.status = status;
    realtimeState.handlers.forEach((handler) => handler(status));
  });
}

describe('StatusBar', () => {
  beforeEach(() => {
    realtimeState.status = 'idle';
    realtimeState.handlers.clear();
    mockIntentCtx.value = null;
    mockProjects.projects = [];
  });

  it('names the application version and the environment', () => {
    render(<StatusBar />);

    expect(screen.getByText('v2.0.0-test · test')).toBeInTheDocument();
    expect(screen.queryByText(/Live updates/)).not.toBeInTheDocument();
  });

  it('says "Live updates" only once the application event stream is connected', () => {
    render(<StatusBar />);

    setStatus('connected');
    const live = screen.getByText('Live updates');
    expect(live).toBeInTheDocument();
    expect(live.closest('[title]')).toHaveAttribute(
      'title',
      'Status changes appear without refreshing. Collaborative editing shows its own status on the page.',
    );
  });

  it('reports every other state as paused live updates', () => {
    render(<StatusBar />);

    setStatus('connecting');
    expect(screen.getByRole('status')).toHaveTextContent('Live updates paused');
    expect(screen.getByRole('status')).toHaveAttribute('title', 'Connecting to live updates.');

    setStatus('disconnected');
    expect(screen.getByRole('status')).toHaveTextContent('Live updates paused');
    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      'Live updates paused. Reconnecting automatically.',
    );
    expect(screen.queryByText(/^Live updates$/)).not.toBeInTheDocument();
  });

  it('keeps footer text at or above the 11 px floor and readable', () => {
    render(<StatusBar />);
    const footer = screen.getByRole('contentinfo');
    expect(footer.className).toContain('text-2xs');
    expect(footer.innerHTML).not.toContain('text-[10px]');
    expect(footer.innerHTML).not.toContain('muted-foreground/50');
  });

  it('pauses while a collaboration alert on the page shows the connection unavailable', () => {
    const { rerender } = render(
      <>
        <StatusBar />
        <CollaborationStatusAlert connection="unavailable" onRetry={vi.fn()} context="answers" />
      </>,
    );
    setStatus('connected');
    expect(
      screen.getAllByRole('status').some((el) => /Live updates paused/.test(el.textContent ?? '')),
    ).toBe(true);

    rerender(
      <>
        <StatusBar />
        <CollaborationStatusAlert connection="synced" onRetry={vi.fn()} context="answers" />
      </>,
    );
    expect(screen.getByText('Live updates')).toBeInTheDocument();
  });

  it('says "Live updates paused" while the page reports its collaboration unavailable', () => {
    const { rerender } = render(
      <>
        <StatusBar />
        <CollaborativePage connection="unavailable" />
      </>,
    );
    setStatus('connected');
    expect(screen.queryByText('Live updates')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Live updates paused');
    expect(screen.getByRole('status')).toHaveAttribute(
      'title',
      'Live collaboration on this page is unavailable. The page says what is affected.',
    );

    rerender(
      <>
        <StatusBar />
        <CollaborativePage connection="synced" />
      </>,
    );
    expect(screen.getByText('Live updates')).toBeInTheDocument();
  });

  it('goes back to "Live updates" when the unavailable page unmounts', () => {
    const { rerender } = render(
      <>
        <StatusBar />
        <CollaborativePage connection="unavailable" />
      </>,
    );
    setStatus('connected');
    rerender(<StatusBar />);
    expect(screen.getByText('Live updates')).toBeInTheDocument();
  });

  describe('pages with nothing live', () => {
    it.each(['FAILED', 'CANCELLED', 'SUCCEEDED'])(
      'says "Up to date" instead of "Live updates" on a %s intent',
      (status) => {
        mockIntentCtx.value = intentDetail('i1', status);
        renderAt('/space/p1/intent/i1');
        setStatus('connected');
        expect(screen.queryByText('Live updates')).toBeNull();
        const upToDate = screen.getByText('Up to date');
        expect(upToDate.closest('[title]')).toHaveAttribute(
          'title',
          'This run has ended. Nothing on this page changes on its own.',
        );
      },
    );

    it('does the same on the Audit of an ended intent', () => {
      mockIntentCtx.value = intentDetail('i1', 'CANCELLED');
      renderAt('/space/p1/intent/i1/audit');
      setStatus('connected');
      expect(screen.queryByText('Live updates')).toBeNull();
      expect(screen.getByText('Up to date')).toBeInTheDocument();
    });

    it.each(['RUNNING', 'WAITING', 'CREATED'])('keeps "Live updates" on a %s intent', (status) => {
      mockIntentCtx.value = intentDetail('i1', status);
      renderAt('/space/p1/intent/i1');
      setStatus('connected');
      expect(screen.getByText('Live updates')).toBeInTheDocument();
      expect(screen.queryByText('Up to date')).toBeNull();
    });

    it('keeps "Live updates" while the intent detail is not loaded yet or belongs to another intent', () => {
      mockIntentCtx.value = intentDetail('other', 'FAILED');
      renderAt('/space/p1/intent/i1');
      setStatus('connected');
      expect(screen.getByText('Live updates')).toBeInTheDocument();
    });

    it('says "Up to date" on a read-only legacy sprint and on a legacy space', () => {
      mockProjects.projects = [{ project: { id: 'legacy', kind: 'v1' } }];
      const { unmount } = renderAt('/space/legacy/sprint/s1');
      setStatus('connected');
      expect(screen.getByText('Up to date').closest('[title]')).toHaveAttribute(
        'title',
        'Legacy space, read-only. Nothing on this page changes on its own.',
      );
      unmount();
      renderAt('/space/legacy');
      setStatus('connected');
      expect(screen.getByText('Up to date')).toBeInTheDocument();
      expect(screen.queryByText('Live updates')).toBeNull();
    });

    it('keeps "Live updates" on a v2 space and on the dashboard', () => {
      mockProjects.projects = [{ project: { id: 'p1', kind: 'v2' } }];
      const { unmount } = renderAt('/space/p1');
      setStatus('connected');
      expect(screen.getByText('Live updates')).toBeInTheDocument();
      unmount();
      renderAt('/dashboard');
      setStatus('connected');
      expect(screen.getByText('Live updates')).toBeInTheDocument();
    });

    it('still reports a paused connection on an ended intent', () => {
      mockIntentCtx.value = intentDetail('i1', 'FAILED');
      renderAt('/space/p1/intent/i1');
      setStatus('disconnected');
      expect(screen.getByRole('status')).toHaveTextContent('Live updates paused');
      expect(screen.queryByText('Up to date')).toBeNull();
    });
  });
});
