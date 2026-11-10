// The composer's plan check against the stable release (#607): it only claims
// the release check when the reads actually used the release.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Link, MemoryRouter, Route, Routes } from 'react-router';

const get = vi.fn();
const compiled = vi.fn();
const executionPreview = vi.fn();
const update = vi.fn();
const list = vi.fn();
const stableCatalog = vi.fn();
const catalog = vi.fn();
const getBlock = vi.fn();
const createBlock = vi.fn();
const putScopeMembership = vi.fn();
const removeScopeRef = vi.fn();
const releaseBlock = vi.fn();

vi.mock('@/services/workflows', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/workflows')>();
  return {
    ...original,
    workflowsService: {
      get: (...a: unknown[]) => get(...a),
      compiled: (...a: unknown[]) => compiled(...a),
      executionPreview: (...a: unknown[]) => executionPreview(...a),
      update: (...a: unknown[]) => update(...a),
      putScopeMembership: (...a: unknown[]) => putScopeMembership(...a),
      removeScopeRef: (...a: unknown[]) => removeScopeRef(...a),
    },
  };
});
vi.mock('@/services/blocks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/blocks')>();
  return {
    ...original,
    blocksService: {
      list: (...a: unknown[]) => list(...a),
      get: (...a: unknown[]) => getBlock(...a),
      create: (...a: unknown[]) => createBlock(...a),
    },
  };
});
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      stableCatalog: (...a: unknown[]) => stableCatalog(...a),
      catalog: (...a: unknown[]) => catalog(...a),
      block: (...a: unknown[]) => releaseBlock(...a),
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
  getBlock.mockReset();
  createBlock.mockReset();
  putScopeMembership.mockReset();
  removeScopeRef.mockReset();
  releaseBlock.mockReset();
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

  it('drops the loaded version when a newly selected version fails to load', async () => {
    const first = 'aidlc:2.11.1';
    const second = 'aidlc:2.11.3';
    catalog.mockImplementation((releaseId: string) =>
      releaseId === first
        ? Promise.resolve({
            releaseId: first,
            release: { releaseId: first, upstreamVersion: '2.11.1' },
            contents: { workflow: null, blocks: { stage: [], scope: [] } },
          })
        : Promise.reject(new Error('2.11.3 unavailable')),
    );
    compiled.mockImplementation((...args: unknown[]) =>
      Promise.resolve(compiledView({ libraryRelease: args[5] })),
    );
    executionPreview.mockImplementation((...args: unknown[]) =>
      Promise.resolve(previewOf({ libraryRelease: args[7] })),
    );
    let finishSave!: (value: unknown) => void;
    update.mockReturnValue(
      new Promise((resolve) => {
        finishSave = resolve;
      }),
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter
        initialEntries={[`/workflows/my-flow?libraryRelease=${encodeURIComponent(first)}`]}
      >
        <Link to={`/workflows/my-flow?libraryRelease=${encodeURIComponent(second)}`}>
          Switch version
        </Link>
        <Routes>
          <Route path="/workflows/:workflowId" element={<WorkflowComposer />} />
        </Routes>
      </MemoryRouter>,
    );
    expect(await screen.findByTestId('composer-library-release')).toHaveTextContent(
      'AI-DLC 2.11.1',
    );
    // A save started against the first version is still in flight.
    await user.click(screen.getByRole('button', { name: 'Save workflow' }));
    expect(update).toHaveBeenCalledTimes(1);

    await user.click(screen.getByRole('link', { name: 'Switch version' }));
    expect(await screen.findByText('2.11.3 unavailable')).toBeInTheDocument();
    const compiledCallsBefore = compiled.mock.calls.length;
    await act(async () => {
      finishSave({});
    });

    expect(screen.queryByTestId('composer-library-release')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Save workflow|Saving/ })).not.toBeInTheDocument();
    expect(screen.queryByDisplayValue('My flow')).not.toBeInTheDocument();
    expect(compiled.mock.calls.slice(compiledCallsBefore)).toEqual([]);
  });
});

it('opens a release-origin stage from the release it was resolved from', async () => {
  const workflow = await get.getMockImplementation()?.();
  get.mockResolvedValue({
    ...workflow,
    phases: [
      {
        phaseId: 'inception',
        name: 'Inception',
        kind: 'phase',
        path: '01',
        parentPath: null,
        order: 1,
      },
    ],
    placements: [
      {
        stageId: 'requirements',
        stageTenant: 'SYSTEM',
        pinnedVersion: null,
        phasePath: '01',
        order: 0,
        scopeMembership: { mvp: 'EXECUTE' },
      },
    ],
  });
  const releaseStage = {
    id: 'requirements',
    blockId: 'requirements',
    blockType: 'stage',
    tenantId: 'SYSTEM',
    name: 'Release requirements',
    readOnly: true,
    phase: 'inception',
    source: 'release',
    releaseId: STABLE,
  };
  stableCatalog.mockResolvedValue({
    releaseId: STABLE,
    release: { releaseId: STABLE, upstreamVersion: '2.11.0' },
    contents: { release: { releaseId: STABLE }, workflow: null, blocks: { stage: [releaseStage] } },
  });
  releaseBlock.mockResolvedValue({ block: releaseStage, body: '', script: '' });
  getBlock.mockRejectedValue(new Error('Not found'));
  compiled.mockResolvedValue(compiledView({ libraryRelease: STABLE }));
  executionPreview.mockResolvedValue(previewOf({ libraryRelease: STABLE }));
  const user = userEvent.setup();

  renderComposer();

  await user.click(await screen.findByTitle('Open stage'));
  expect(await screen.findByRole('dialog')).toHaveTextContent('Release requirements');
  expect(releaseBlock).toHaveBeenCalledWith(STABLE, 'stage', 'requirements');
  expect(getBlock).not.toHaveBeenCalled();
});

// A scope created while a version is selected is a library block. Detaching it
// from the workflow keeps the block, so adding it back must reuse it rather
// than try to create it a second time.
it('reuses a scope block created under a selected version when it is added back', async () => {
  const selected = 'aidlc:2.9.0';
  let current = {
    ...(await get.getMockImplementation()?.()),
    phases: [
      {
        phaseId: 'inception',
        name: 'Inception',
        kind: 'phase',
        path: '01',
        parentPath: null,
        order: 1,
      },
    ],
    placements: [
      {
        stageId: 'requirements',
        stageTenant: 'SYSTEM',
        pinnedVersion: null,
        phasePath: '01',
        order: 0,
        scopeMembership: {},
      },
    ],
    scopeRefs: [] as { scopeId: string; scopeTenant: string }[],
  };
  get.mockImplementation(async () => current);
  const leanScope = {
    id: 'lean',
    blockId: 'lean',
    blockType: 'scope',
    tenantId: 'default',
    name: 'Lean',
  };
  let scopes: unknown[] = [];
  list.mockImplementation(async (type: string) => ({ blocks: type === 'scope' ? scopes : [] }));
  createBlock.mockImplementation(async () => {
    scopes = [leanScope];
    return leanScope;
  });
  putScopeMembership.mockImplementation(
    async (_w: string, scopeId: string, _s: string[], scopeTenant: string) => {
      current = { ...current, scopeRefs: [{ scopeId, scopeTenant }] };
      return current;
    },
  );
  removeScopeRef.mockImplementation(async () => {
    current = { ...current, scopeRefs: [] };
  });
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
  const user = userEvent.setup();

  renderComposer(`/workflows/my-flow?libraryRelease=${encodeURIComponent(selected)}`);
  await screen.findByTestId('composer-library-release');
  await user.click(screen.getByRole('tab', { name: 'Scopes' }));

  const addLean = async () => {
    await user.click(screen.getByRole('button', { name: /new/i }));
    await user.type(screen.getByLabelText(/scope name/i), 'Lean');
    await user.click(screen.getByLabelText(/inception/i));
    await user.click(screen.getByRole('button', { name: /create scope/i }));
  };

  await addLean();
  const leanButton = await screen.findByRole('button', { name: /^lean$/i });
  await user.click(leanButton.nextElementSibling as HTMLElement);
  await waitFor(() => expect(removeScopeRef).toHaveBeenCalledTimes(1));
  await waitFor(() => expect(screen.queryByRole('button', { name: /^lean$/i })).toBeNull());

  await addLean();
  await waitFor(() => expect(putScopeMembership).toHaveBeenCalledTimes(2));
  expect(createBlock).toHaveBeenCalledTimes(1);
  expect(putScopeMembership).toHaveBeenLastCalledWith(
    'my-flow',
    'lean',
    ['requirements'],
    'default',
  );
});

// Under a selected version, a pinned intent resolves stages from the release
// and the library only. A stage only the SYSTEM rows have is not offered to add.
it('offers only stages the selected version can resolve', async () => {
  const selected = 'aidlc:2.9.0';
  const stage = (id: string, tenantId: string) => ({
    id,
    blockId: id,
    blockType: 'stage',
    tenantId,
    name: `Stage ${id}`,
    readOnly: tenantId === 'SYSTEM',
    phase: 'inception',
  });
  list.mockImplementation(async (type: string) => ({
    blocks: type === 'stage' ? [stage('system-only', 'SYSTEM'), stage('mine', 'default')] : [],
  }));
  catalog.mockResolvedValue({
    releaseId: selected,
    release: { releaseId: selected, upstreamVersion: '2.9.0' },
    contents: {
      release: { releaseId: selected, upstreamVersion: '2.9.0' },
      workflow: null,
      blocks: {
        stage: [{ ...stage('from-release', 'SYSTEM'), source: 'release', releaseId: selected }],
        scope: [],
      },
    },
  });
  compiled.mockResolvedValue(compiledView({ libraryRelease: selected }));
  executionPreview.mockResolvedValue(previewOf({ libraryRelease: selected }));
  const user = userEvent.setup();

  renderComposer(`/workflows/my-flow?libraryRelease=${encodeURIComponent(selected)}`);
  await screen.findByTestId('composer-library-release');
  await user.click(screen.getByRole('button', { name: /add existing stage/i }));

  expect(await screen.findByText('Stage from-release')).toBeInTheDocument();
  expect(screen.getByText('Stage mine')).toBeInTheDocument();
  expect(screen.queryByText('Stage system-only')).toBeNull();
});
