import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router';
import { ApiError } from '@/services/api';
import { clearNativeIntents } from '@/hooks/useNativeIntents';
import { resetSessionExpiry } from '@/services/sessionExpiry';
import type { NativeIntentSummary } from '@/services/nativeIntents';

const mocks = vi.hoisted(() => ({
  list: vi.fn(),
  nativeList: vi.fn(),
  nativeGet: vi.fn(),
  deleteIntent: vi.fn(),
}));
vi.mock('@/hooks/useProjectsCache', () => ({
  useProjectCache: () => ({
    project: {
      id: 'p1',
      name: 'Space',
      kind: 'v2',
      workflowId: 'aidlc-v2',
      userRole: 'owner',
      trackers: [],
    },
    loading: false,
  }),
  useProjectSprintsCache: () => ({ sprints: [], refresh: () => {} }),
}));
vi.mock('@/hooks/useSprintEvents', () => ({ useSprintEvents: () => {} }));
vi.mock('@/services/nativeIntents', () => ({
  nativeIntentsService: { list: mocks.nativeList, get: mocks.nativeGet },
}));
vi.mock('@/services/intents', () => ({
  intentsService: {
    list: mocks.list,
    delete: mocks.deleteIntent,
    projectMetrics: async () => ({
      perIntent: [],
      project: { metrics: {}, cost: { totalCost: 0 } },
    }),
  },
}));
import Project, { clearIntentsCacheForTests } from './Project';
import NativeIntentPage from './NativeIntentPage';

const summary = (id = 'same'): NativeIntentSummary => ({
  id,
  projectId: 'p1',
  title: `Native ${id}`,
  executionBackend: 'native',
  harness: 'kiro',
  status: 'READY',
  package: {
    version: '2.9.0',
    source: { provider: 'github', repository: 'owner/fork', release: 'v2.9.0' },
  },
  createdAt: '2026-09-29T07:00:00Z',
  updatedAt: '2026-09-29T07:00:00Z',
});
const platform = {
  id: 'same',
  projectId: 'p1',
  title: 'Platform same',
  status: 'DRAFT',
  currentStage: 'requirements',
  createdAt: '2026-09-29T07:00:00Z',
};
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={['/space/p1']}>
      <Routes>
        <Route path="/space/:projectId" element={<Project />} />
        <Route path="/space/:projectId/native-intent/:intentId" element={<NativeIntentPage />} />
        <Route path="/space/:projectId/intent/:intentId" element={<p>Platform detail route</p>} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  vi.resetAllMocks();
  clearNativeIntents();
  clearIntentsCacheForTests();
  sessionStorage.clear();
  mocks.list.mockResolvedValue([platform]);
  mocks.nativeList.mockResolvedValue({ items: [summary()], nextCursor: null });
  mocks.nativeGet.mockResolvedValue({ ...summary(), prompt: 'Protected native prompt' });
});

describe('Space native discovery', () => {
  it('shows a usable fallback label for a prompt-only native draft', async () => {
    mocks.nativeList.mockResolvedValueOnce({
      items: [{ ...summary(), title: '' }],
      nextCursor: null,
    });
    renderPage();
    const row = await screen.findByRole('button', {
      name: /Untitled native intent Native Workspace ready/,
    });
    await userEvent.click(row);
    expect(await screen.findByText('Protected native prompt')).toBeInTheDocument();
  });
  it('continues past an empty native page without claiming the inventory is empty', async () => {
    mocks.list.mockResolvedValue([]);
    mocks.nativeList
      .mockResolvedValueOnce({ items: [], nextCursor: 'next' })
      .mockResolvedValueOnce({ items: [summary('later')], nextCursor: null });
    renderPage();
    await screen.findByRole('button', { name: 'Load more native intents' });
    expect(screen.queryByText('No intents yet')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load more native intents' }));
    expect(await screen.findByText('Native later')).toBeInTheDocument();
    expect(mocks.nativeList).toHaveBeenLastCalledWith('p1', 'next');
  });
  it('keeps equal UUIDs separate, labels readiness, and opens the protected native status endpoint', async () => {
    renderPage();
    const row = await screen.findByRole('button', { name: /Native same Native Workspace ready/ });
    expect(screen.getByText('Platform same')).toBeInTheDocument();
    expect(within(row).queryByText(/stage:/)).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete intent' })).toBeDisabled();
    await userEvent.click(row);
    expect(await screen.findByText('Protected native prompt')).toBeInTheDocument();
    expect(mocks.nativeGet).toHaveBeenCalledWith('p1', 'same');
    expect(screen.queryByText('Platform detail route')).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Start agent' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Answer question' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Edit artifacts' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Create unit PR' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Delete intent' })).toBeDisabled();
    expect(screen.queryByText('Done')).not.toBeInTheDocument();
  });
  it('preserves platform routing and native delete cannot invoke the platform handler', async () => {
    renderPage();
    const row = await screen.findByRole('button', { name: /Native same Native Workspace ready/ });
    fireEvent.click(within(row).getByRole('button', { name: 'Delete intent' }));
    expect(mocks.deleteIntent).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Platform same/ }));
    expect(screen.getByText('Platform detail route')).toBeInTheDocument();
  });
  it('does not promote an agent-writable platform backend flag into a protected native entry', async () => {
    mocks.list.mockResolvedValue([{ ...platform, executionBackend: 'native' }]);
    mocks.nativeList.mockResolvedValue({ items: [], nextCursor: null });
    renderPage();
    const row = await screen.findByRole('button', { name: /Platform same Unsupported backend/ });
    expect(row).toHaveAttribute('aria-disabled', 'true');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    expect(mocks.nativeGet).not.toHaveBeenCalled();
    expect(screen.queryByText('Platform detail route')).not.toBeInTheDocument();
    expect(within(row).queryByText('Native')).not.toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Delete intent' })).toBeDisabled();
  });
  it('offers explicit native pagination and keeps earlier pages visible', async () => {
    mocks.nativeList
      .mockResolvedValueOnce({ items: [summary('first')], nextCursor: 'second-page' })
      .mockResolvedValueOnce({ items: [summary('later')], nextCursor: null });
    renderPage();
    await screen.findByText('Native first');
    await userEvent.click(screen.getByRole('button', { name: 'Load more native intents' }));
    expect(await screen.findByText('Native later')).toBeInTheDocument();
    expect(screen.getByText('Native first')).toBeInTheDocument();
    expect(mocks.nativeList).toHaveBeenLastCalledWith('p1', 'second-page');
    expect(
      screen.queryByRole('button', { name: 'Load more native intents' }),
    ).not.toBeInTheDocument();
  });
  it('shows a partial native error alongside platform rows and retries only native loading', async () => {
    mocks.nativeList.mockRejectedValueOnce(new ApiError(503, 'unavailable'));
    renderPage();
    expect(await screen.findByRole('alert')).toHaveTextContent(
      /Native intents could not be refreshed/,
    );
    expect(screen.getByText('Platform same')).toBeInTheDocument();
    mocks.nativeList.mockResolvedValueOnce({ items: [summary()], nextCursor: null });
    await userEvent.click(screen.getByRole('button', { name: 'Retry native intents' }));
    expect(await screen.findByText('Native same')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(mocks.list).toHaveBeenCalledTimes(1);
  });
  it('removes a stale private title on denied refresh and account switch', async () => {
    renderPage();
    await screen.findByText('Native same');
    mocks.nativeList.mockRejectedValue(new ApiError(403, 'not a member'));
    act(() => resetSessionExpiry());
    expect(screen.queryByText('Native same')).not.toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('alert')).toHaveTextContent(/no longer accessible/),
    );
    expect(screen.getByText('Platform same')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Retry native intents' }));
    expect(screen.queryByText('Native same')).not.toBeInTheDocument();
  });
});
