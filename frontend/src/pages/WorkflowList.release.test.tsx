// The workflow list under an explicitly selected AI-DLC version: every way to
// create a workflow waits for that version, and the version travels with the
// author into a workflow and back.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';

const list = vi.fn();
const catalog = vi.fn();
const stableCatalog = vi.fn();

vi.mock('@/services/workflows', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/workflows')>();
  return {
    ...original,
    workflowsService: { list: (...a: unknown[]) => list(...a) },
  };
});
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      catalog: (...a: unknown[]) => catalog(...a),
      stableCatalog: (...a: unknown[]) => stableCatalog(...a),
    },
  };
});

import WorkflowList from './WorkflowList';

const SELECTED = 'aidlc:2.9.0';

const Where = () => {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
};

const renderList = (search = `?libraryRelease=${encodeURIComponent(SELECTED)}`) =>
  render(
    <MemoryRouter initialEntries={[`/workflows${search}`]}>
      <Routes>
        <Route path="/workflows" element={<WorkflowList />} />
        <Route path="/workflows/:workflowId" element={<Where />} />
      </Routes>
    </MemoryRouter>,
  );

beforeEach(() => {
  list.mockReset().mockResolvedValue({ workflows: [] });
  catalog.mockReset();
  stableCatalog.mockReset().mockResolvedValue(null);
});

describe('WorkflowList under a selected version', () => {
  it('keeps every create entry closed while the selected version cannot be read', async () => {
    catalog.mockRejectedValue(new Error('release unreadable'));
    renderList();

    expect(await screen.findByRole('alert')).toBeInTheDocument();
    const creates = await screen.findAllByRole('button', { name: /new workflow/i });
    expect(creates.length).toBeGreaterThan(1);
    for (const button of creates) expect(button).toBeDisabled();
  });

  it('opens a workflow with the selected version', async () => {
    catalog.mockResolvedValue({
      releaseId: SELECTED,
      release: { releaseId: SELECTED, upstreamVersion: '2.9.0' },
      contents: { release: { releaseId: SELECTED }, workflow: null, blocks: {} },
    });
    list.mockResolvedValue({
      workflows: [{ id: 'my-flow', name: 'My flow', readOnly: false, version: 1 }],
    });
    const user = userEvent.setup();
    renderList();

    await user.click(await screen.findByText('My flow'));

    await waitFor(() =>
      expect(screen.getByTestId('where')).toHaveTextContent(
        `/workflows/my-flow?libraryRelease=${encodeURIComponent(SELECTED)}`,
      ),
    );
  });
});
