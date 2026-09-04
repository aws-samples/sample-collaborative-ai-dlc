import { describe, it, expect } from 'vitest';
import { computeUnitLaneLayout, type UnitLanesInput } from './unit-lane-graph';
import type { CompiledWorkflow } from '@/services/workflows';

// Construction (phase '04') has a fan-out section of two stages + a post stage.
// NB: the two fan-out stages carry DIFFERENT `section` values on purpose — the
// upstream compiled `section` index is unreliable, and the layout must ignore it
// and rely on `sectionStageIds` (derived from forEach + order) instead.
const nodes: CompiledWorkflow['graph']['nodes'] = [
  { stageId: 'requirements', phasePath: '03', order: 0 },
  { stageId: 'func-design', phasePath: '04', order: 1, forEach: 'unit-of-work', section: 2 },
  { stageId: 'code-gen', phasePath: '04', order: 2, forEach: 'unit-of-work', section: 3 },
  { stageId: 'build-and-test', phasePath: '04', order: 3 },
] as unknown as CompiledWorkflow['graph']['nodes'];

const phases = [
  { path: '03', name: 'Inception' },
  { path: '04', name: 'Construction' },
];

const lanes: UnitLanesInput = {
  sectionStageIds: ['func-design', 'code-gen'],
  units: [
    {
      slug: 'project-setup',
      state: 'MERGED',
      stages: [
        {
          stageId: 'func-design',
          stageInstanceId: 'si-1',
          state: 'SUCCEEDED',
          synthesized: false,
          rowKey: 'si-1',
        },
        {
          stageId: 'code-gen',
          stageInstanceId: 'si-2',
          state: 'SUCCEEDED',
          synthesized: false,
          rowKey: 'si-2',
        },
      ],
    },
    {
      slug: 'api-client',
      state: 'RUNNING',
      stages: [
        {
          stageId: 'func-design',
          stageInstanceId: 'si-3',
          state: 'RUNNING',
          synthesized: false,
          rowKey: 'si-3',
        },
        {
          stageId: 'code-gen',
          stageInstanceId: null,
          state: 'PENDING',
          synthesized: true,
          rowKey: null,
        },
      ],
    },
  ],
};

describe('computeUnitLaneLayout', () => {
  it('returns null when there are no section stages or units', () => {
    expect(computeUnitLaneLayout(nodes, phases, { units: [], sectionStageIds: [] })).toBeNull();
    expect(
      computeUnitLaneLayout(nodes, phases, { units: lanes.units, sectionStageIds: [] }),
    ).toBeNull();
  });

  it('returns null when the fan-out phase is not among the provided phases', () => {
    // Simulates the transient where workflow phase metadata has not loaded yet
    // (empty / partial phases). A degenerate one-column layout must NOT render.
    expect(computeUnitLaneLayout(nodes, [], lanes)).toBeNull();
    expect(computeUnitLaneLayout(nodes, [{ path: '03', name: 'Inception' }], lanes)).toBeNull();
  });

  it('drops empty phase columns but keeps ones with nodes and the fan-out phase', () => {
    const withEmpty = [
      { path: '02', name: 'Ideation' }, // no nodes → dropped
      { path: '03', name: 'Inception' }, // has requirements
      { path: '04', name: 'Construction' }, // fan-out
      { path: '05', name: 'Operation' }, // no nodes → dropped
    ];
    const layout = computeUnitLaneLayout(nodes, withEmpty, lanes)!;
    const paths = layout.phaseColumns.map((c) => c.phasePath);
    expect(paths).toContain('03');
    expect(paths).toContain('04');
    expect(paths).not.toContain('02');
    expect(paths).not.toContain('05');
  });

  it('emits a synthetic unit node and a per-unit stage node per cell', () => {
    const layout = computeUnitLaneLayout(nodes, phases, lanes)!;
    expect(layout).not.toBeNull();
    // unit nodes
    expect(layout.nodes.has('unit:project-setup')).toBe(true);
    expect(layout.nodes.has('unit:api-client')).toBe(true);
    // per-unit stage cells
    expect(layout.nodes.has('stage:func-design:project-setup')).toBe(true);
    expect(layout.nodes.has('stage:code-gen:api-client')).toBe(true);
    // pre + post plan stages keep their plain stageId keys
    expect(layout.nodes.get('requirements')?.kind).toBe('stage');
    expect(layout.nodes.get('build-and-test')?.kind).toBe('stage');
  });

  it('orders units by the provided (wave) order, not alphabetically', () => {
    const layout = computeUnitLaneLayout(nodes, phases, lanes)!;
    const setup = layout.nodes.get('unit:project-setup')!;
    const api = layout.nodes.get('unit:api-client')!;
    // project-setup (wave 0) is above api-client (wave 1)
    expect(setup.y).toBeLessThan(api.y);
  });

  it('positions build-and-test to the right of the unit lane', () => {
    const layout = computeUnitLaneLayout(nodes, phases, lanes)!;
    const laneCell = layout.nodes.get('stage:func-design:project-setup')!;
    const post = layout.nodes.get('build-and-test')!;
    expect(post.x).toBeGreaterThan(laneCell.x);
  });

  it('draws edges from each unit node to its stage cells and from last cell to post', () => {
    const layout = computeUnitLaneLayout(nodes, phases, lanes)!;
    // unit node → FIRST cell only
    expect(
      layout.edges.some(
        (e) => e.from === 'unit:project-setup' && e.to === 'stage:func-design:project-setup',
      ),
    ).toBe(true);
    // last stage of each unit → build-and-test
    expect(
      layout.edges.some(
        (e) => e.from === 'stage:code-gen:project-setup' && e.to === 'build-and-test',
      ),
    ).toBe(true);
  });

  it('chains per-unit stage cells (func-design → code-gen) as vertical edges', () => {
    const layout = computeUnitLaneLayout(nodes, phases, lanes)!;
    const chain = layout.edges.find(
      (e) =>
        e.from === 'stage:func-design:project-setup' && e.to === 'stage:code-gen:project-setup',
    );
    expect(chain).toBeTruthy();
    expect(chain!.vertical).toBe(true);
    // the unit node does NOT connect directly to the 2nd cell
    expect(
      layout.edges.some(
        (e) => e.from === 'unit:project-setup' && e.to === 'stage:code-gen:project-setup',
      ),
    ).toBe(false);
  });

  it('carries synthesized/rowKey/state through to the cell nodes', () => {
    const layout = computeUnitLaneLayout(nodes, phases, lanes)!;
    const pending = layout.nodes.get('stage:code-gen:api-client')!;
    expect(pending.synthesized).toBe(true);
    expect(pending.rowKey).toBeNull();
    expect(pending.state).toBe('PENDING');
    const done = layout.nodes.get('stage:func-design:project-setup')!;
    expect(done.rowKey).toBe('si-1');
    expect(done.state).toBe('SUCCEEDED');
  });

  it('remaps compiled edges touching fan-out stages to the per-unit nodes', () => {
    const edges = [
      { from: 'requirements', to: 'func-design', kind: 'data' }, // into fan-out
    ] as unknown as import('@/services/workflows').CompiledWorkflow['graph']['edges'];
    const layout = computeUnitLaneLayout(nodes, phases, lanes, edges)!;
    // upstream → each unit node (not dropped, not to the raw stageId)
    expect(
      layout.edges.some((e) => e.from === 'requirements' && e.to === 'unit:project-setup'),
    ).toBe(true);
    expect(layout.edges.some((e) => e.from === 'requirements' && e.to === 'unit:api-client')).toBe(
      true,
    );
    // never a dangling edge to the fan-out stageId itself
    expect(layout.edges.some((e) => e.to === 'func-design')).toBe(false);
  });

  it('carries over compiled edges between plain stages', () => {
    const edges = [
      { from: 'requirements', to: 'build-and-test', kind: 'requires' },
    ] as unknown as import('@/services/workflows').CompiledWorkflow['graph']['edges'];
    const layout = computeUnitLaneLayout(nodes, phases, lanes, edges)!;
    const kept = layout.edges.find((e) => e.from === 'requirements' && e.to === 'build-and-test');
    expect(kept).toBeTruthy();
    expect(kept!.kind).toBe('requires');
  });
});
