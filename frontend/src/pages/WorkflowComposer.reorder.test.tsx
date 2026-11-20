// Reordering stages saves one placement at a time: each update publishes a new
// workflow version, and parallel updates would conflict with each other.
import { beforeEach, expect, it, vi } from 'vitest';
import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router';

const get = vi.fn();
const updatePlacement = vi.fn();

vi.mock('@/services/workflows', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/workflows')>();
  return {
    ...original,
    workflowsService: {
      get: (...a: unknown[]) => get(...a),
      compiled: () =>
        Promise.resolve({
          scopeGrid: {},
          autonomy: { perStage: {}, rollup: { selfHalting: 0, mixed: 0, humanGated: 0, total: 0 } },
          graph: { nodes: [], edges: [], warnings: [] },
        }),
      executionPreview: () =>
        Promise.resolve({ valid: true, errors: [], warnings: [], plan: null }),
      updatePlacement: (...a: unknown[]) => updatePlacement(...a),
    },
  };
});
vi.mock('@/services/blocks', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/blocks')>();
  return { ...original, blocksService: { list: () => Promise.resolve({ blocks: [] }) } };
});
vi.mock('@/services/aidlcReleases', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/services/aidlcReleases')>();
  return {
    ...original,
    aidlcReleasesService: {
      stableCatalog: () => Promise.resolve(null),
      catalog: () => Promise.resolve(null),
    },
  };
});
// Drag and drop is covered by the lanes' own tests; expose the reorder callback.
vi.mock('./composer/PhaseLanes', () => ({
  PhaseLanes: ({
    onReorderPlacement,
  }: {
    onReorderPlacement: (stageId: string, phasePath: string | null, index: number) => void;
  }) => (
    <button type="button" onClick={() => onReorderPlacement('third', null, 0)}>
      Move third first
    </button>
  ),
}));

import WorkflowComposer from './WorkflowComposer';

globalThis.ResizeObserver ??= class {
  observe() {}
  unobserve() {}
  disconnect() {}
} as unknown as typeof ResizeObserver;

const placement = (stageId: string, order: number) => ({
  stageId,
  stageTenant: 'default',
  pinnedVersion: null,
  phasePath: null,
  order,
  scopeMembership: {},
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
    placements: [placement('first', 0), placement('second', 1), placement('third', 2)],
    scopeRefs: [],
    ruleRefs: [],
  });
  updatePlacement.mockReset();
});

it('saves a reorder one placement at a time', async () => {
  const pending: Array<() => void> = [];
  let inFlight = 0;
  let maxInFlight = 0;
  updatePlacement.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        pending.push(() => {
          inFlight -= 1;
          resolve();
        });
      }),
  );
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={['/workflows/my-flow']}>
      <Routes>
        <Route path="/workflows/:workflowId" element={<WorkflowComposer />} />
      </Routes>
    </MemoryRouter>,
  );
  await user.click(await screen.findByRole('button', { name: 'Move third first' }));
  for (let call = 1; call <= 3; call += 1) {
    await waitFor(() => expect(updatePlacement).toHaveBeenCalledTimes(call));
    expect(inFlight).toBe(1);
    await act(async () => pending.shift()?.());
  }
  expect(maxInFlight).toBe(1);
  expect(updatePlacement.mock.calls.map(([, stageId, input]) => [stageId, input.order])).toEqual([
    ['third', 0],
    ['first', 1],
    ['second', 2],
  ]);
});
