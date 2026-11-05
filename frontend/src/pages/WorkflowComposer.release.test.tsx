// The composer's plan check against the stable release (#607): it only claims
// the release check when the reads actually used the release.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';

const get = vi.fn();
const compiled = vi.fn();
const executionPreview = vi.fn();
const list = vi.fn();
const stableCatalog = vi.fn();
const catalog = vi.fn();

vi.mock('@/services/workflows', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/workflows')>();
  return {
    ...original,
    workflowsService: {
      get: (...a: unknown[]) => get(...a),
      compiled: (...a: unknown[]) => compiled(...a),
      executionPreview: (...a: unknown[]) => executionPreview(...a),
    },
  };
});
vi.mock('@/services/blocks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/blocks')>();
  return { ...original, blocksService: { list: (...a: unknown[]) => list(...a) } };
});
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      stableCatalog: (...a: unknown[]) => stableCatalog(...a),
      catalog: (...a: unknown[]) => catalog(...a),
    },
  };
});

import WorkflowComposer from './WorkflowComposer';

const STABLE = 'aidlc-custom:gitlab:acme/aidlc@abc123';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const compiledView = (over: Record<string, unknown> = {}) => ({
  scopeGrid: {},
  autonomy: { perStage: {}, rollup: { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 } },
  graph: { nodes: [], edges: [], warnings: [] },
  ...over,
});
const previewOf = (over: Record<string, unknown> = {}) => ({
  valid: true,
  errors: [],
  warnings: [],
  plan: null,
  ...over,
});

const renderComposer = (path = '/workflows/my-flow') =>
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowComposer />} />
      </Routes>
    </MemoryRouter>,
  );

it('does not retarget the composer when a previous version loads after the current one', async () => {
  const other = 'aidlc:new-version';
  let resolveOld!: (value: unknown) => void;
  const oldResponse = new Promise((resolve) => {
    resolveOld = resolve;
  });
  const selected = (releaseId: string, version: string) => ({
    releaseId,
    release: { releaseId, upstreamVersion: version },
    contents: { workflow: null, blocks: { stage: [], scope: [] } },
  });
  catalog.mockImplementation((releaseId) =>
    releaseId === STABLE ? oldResponse : Promise.resolve(selected(other, '2.11.3')),
  );
  compiled.mockResolvedValue(compiledView({ libraryRelease: other }));
  executionPreview.mockResolvedValue(previewOf({ libraryRelease: other }));
  const user = userEvent.setup();
  render(
    <MemoryRouter
      initialEntries={[`/workflows/my-flow?libraryRelease=${encodeURIComponent(STABLE)}`]}
    >
      <Link to={`/workflows/my-flow?libraryRelease=${encodeURIComponent(other)}`}>
        Switch version
      </Link>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowComposer />} />
      </Routes>
    </MemoryRouter>,
  );
  await waitFor(() => expect(catalog).toHaveBeenCalledWith(STABLE, expect.any(Array)));
  await user.click(screen.getByRole('link', { name: 'Switch version' }));
  expect(await screen.findByTestId('composer-library-release')).toHaveTextContent('AI-DLC 2.11.3');
  await act(async () => {
    resolveOld(selected(STABLE, '2.11.0'));
  });
  expect(screen.getByTestId('composer-library-release')).toHaveTextContent('AI-DLC 2.11.3');
});

beforeEach(() => {
  get.mockReset().mockResolvedValue({
    id: 'my-flow',
    workflowId: 'my-flow',
    name: 'My flow',
    objective: '',
    owner: 'default',
    readOnly: false,
    version: 1,
    phases: [],
    placements: [],
    scopeRefs: [{ scopeId: 'mvp', scopeTenant: 'SYSTEM' }],
    ruleRefs: [],
  });
  list.mockReset().mockResolvedValue({ blocks: [] });
  stableCatalog.mockReset().mockResolvedValue({
    releaseId: STABLE,
    release: { releaseId: STABLE, upstreamVersion: '2.11.0' },
    contents: { release: { releaseId: STABLE }, workflow: null, blocks: {} },
  });
  catalog.mockReset();
  compiled.mockReset();
  executionPreview.mockReset();
});

describe('WorkflowComposer release plan check', () => {
  it('checks a user workflow against the stable release and says so', async () => {
    compiled.mockResolvedValue(compiledView({ libraryRelease: STABLE }));
    executionPreview.mockResolvedValue(previewOf({ libraryRelease: STABLE }));

    renderComposer();

    expect(await screen.findByTestId('composer-library-release')).toHaveTextContent(
      'Checked against AI-DLC 2.11.0 (stable)',
    );
    expect(compiled).toHaveBeenCalledWith(
      'my-flow',
      undefined,
      undefined,
      undefined,
      undefined,
      STABLE,
    );
    expect(executionPreview).toHaveBeenCalledWith(
      'my-flow',
      'mvp',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      STABLE,
    );
  });

  it('says the release was not used when its read fell back to the library', async () => {
    compiled.mockImplementation((...args: unknown[]) =>
      args[5] ? Promise.reject(new Error('release unreadable')) : Promise.resolve(compiledView()),
    );
    executionPreview.mockImplementation((...args: unknown[]) =>
      args[7] ? Promise.reject(new Error('release unreadable')) : Promise.resolve(previewOf()),
    );

    renderComposer();

    expect(await screen.findByTestId('composer-library-release-unavailable')).toHaveTextContent(
      "couldn't be read: checked against the library only",
    );
    expect(screen.queryByTestId('composer-library-release')).not.toBeInTheDocument();
  });

  it('does not claim the release check when both release and fallback previews fail', async () => {
    compiled.mockResolvedValue(compiledView({ libraryRelease: STABLE }));
    executionPreview.mockRejectedValue(new Error('preview unavailable'));

    renderComposer();

    expect(await screen.findByTestId('composer-library-release-unavailable')).toHaveTextContent(
      "couldn't be read: checked against the library only",
    );
    expect(screen.queryByTestId('composer-library-release')).not.toBeInTheDocument();
  });

  it('does not use the release for a SYSTEM workflow', async () => {
    const workflow = await get.getMockImplementation()?.();
    get.mockResolvedValue({ ...workflow, owner: 'SYSTEM', readOnly: true });
    compiled.mockResolvedValue(compiledView());
    executionPreview.mockResolvedValue(previewOf());

    renderComposer();

    await vi.waitFor(() => expect(executionPreview).toHaveBeenCalled());
    expect(compiled).toHaveBeenCalledWith('my-flow');
    expect(screen.queryByTestId('composer-library-release')).not.toBeInTheDocument();
    expect(screen.queryByTestId('composer-library-release-unavailable')).not.toBeInTheDocument();
  });

  it('checks an explicitly selected version and never substitutes stable', async () => {
    const selected = 'aidlc:2.9.0';
    catalog.mockResolvedValue({
      releaseId: selected,
      release: { releaseId: selected, upstreamVersion: '2.9.0' },
      contents: {
        release: { releaseId: selected, upstreamVersion: '2.9.0' },
        workflow: null,
        blocks: { stage: [], scope: [] },
      },
    });
    compiled.mockResolvedValue(compiledView({ libraryRelease: selected }));
    executionPreview.mockResolvedValue(previewOf({ libraryRelease: selected }));

    renderComposer(`/workflows/my-flow?libraryRelease=${encodeURIComponent(selected)}`);

    expect(await screen.findByTestId('composer-library-release')).toHaveTextContent(
      'Checked against AI-DLC 2.9.0 (selected version)',
    );
    expect(catalog).toHaveBeenCalledWith(selected, ['scope', 'stage']);
    expect(stableCatalog).not.toHaveBeenCalled();
    expect(compiled).toHaveBeenCalledWith(
      'my-flow',
      undefined,
      undefined,
      undefined,
      undefined,
      selected,
    );
    expect(executionPreview).toHaveBeenCalledWith(
      'my-flow',
      'mvp',
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      selected,
    );
  });

  it('surfaces an explicit selected-version failure without checking another version', async () => {
    const selected = 'aidlc:2.9.0';
    catalog.mockResolvedValue({
      releaseId: selected,
      release: { releaseId: selected, upstreamVersion: '2.9.0' },
      contents: {
        release: { releaseId: selected, upstreamVersion: '2.9.0' },
        workflow: null,
        blocks: { stage: [], scope: [] },
      },
    });
    compiled.mockRejectedValue(new Error('selected release unavailable'));

    renderComposer(`/workflows/my-flow?libraryRelease=${encodeURIComponent(selected)}`);

    expect(await screen.findByText('selected release unavailable')).toBeInTheDocument();
    expect(compiled).toHaveBeenCalledTimes(1);
    expect(compiled.mock.calls[0][5]).toBe(selected);
    expect(stableCatalog).not.toHaveBeenCalled();
  });
});
