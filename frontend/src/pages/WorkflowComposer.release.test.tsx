// The composer's plan check against the stable release (#607): it only claims
// the release check when the reads actually used the release.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';

const get = vi.fn();
const compiled = vi.fn();
const executionPreview = vi.fn();
const list = vi.fn();
const stableCatalog = vi.fn();

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
    aidlcReleasesService: { stableCatalog: (...a: unknown[]) => stableCatalog(...a) },
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

const renderComposer = () =>
  render(
    <MemoryRouter initialEntries={['/workflows/my-flow']}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowComposer />} />
      </Routes>
    </MemoryRouter>,
  );

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
});
