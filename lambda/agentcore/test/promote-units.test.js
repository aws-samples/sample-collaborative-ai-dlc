import { describe, it, expect, beforeEach, vi } from 'vitest';
import { promoteUnits, pickCurrentArtifact } from '../commands/promote-units.js';

// WP3 (docs/v2-parallel.md): freezing the approved unit-of-work-dependency
// artifact into the UNITPLAN/UNIT scheduling rows + the graph mirror. The
// graph writer is faked at the createWriter seam (mirrorUnitDag has real
// gremlin coverage in graph-writer.test.js); the store is a spy.

const DAG_BODY = `# Unit of Work Dependency

\`\`\`yaml
units:
  - name: auth
    depends_on: []
  - name: catalog
    depends_on: []
  - name: checkout
    depends_on: [auth, catalog]
\`\`\`
`;

const artifactRow = (over = {}) => ({
  id: 'art-dag-1',
  artifact_type: 'unit-of-work-dependency',
  content: DAG_BODY,
  created_at: '2026-01-01T00:00:00.000Z',
  ...over,
});

const basePayload = {
  projectId: 'p1',
  intentId: 'i1',
  executionId: 'e1',
  stageInstanceId: 'si-units',
};

let store;
let writer;
let deps;
beforeEach(() => {
  store = {
    appendEvent: vi.fn(async () => ({})),
    getUnitPlan: vi.fn(async () => null),
    putUnitPlan: vi.fn(async (input) => ({ ...input, promotedAt: 'T' })),
    syncUnitRows: vi.fn(async () => ({
      created: ['auth', 'catalog', 'checkout'],
      updated: [],
      preserved: [],
      orphaned: [],
    })),
  };
  writer = {
    lookupArtifacts: vi.fn(async () => [artifactRow()]),
    mirrorUnitDag: vi.fn(async () => ({ mirrored: 3, superseded: 0 })),
  };
  deps = {
    store,
    openGraph: vi.fn(async () => ({})),
    createWriter: vi.fn(() => writer),
    broadcast: vi.fn(async () => {}),
    clock: () => 'T',
  };
});

describe('pickCurrentArtifact', () => {
  it('prefers non-superseded rows and the newest timestamp', () => {
    const rows = [
      artifactRow({ id: 'old', created_at: '2026-01-01T00:00:00Z' }),
      artifactRow({ id: 'newer', created_at: '2026-01-02T00:00:00Z' }),
      artifactRow({
        id: 'retired',
        created_at: '2026-01-03T00:00:00Z',
        superseded_at: '2026-01-03T01:00:00Z',
      }),
    ];
    expect(pickCurrentArtifact(rows)?.id).toBe('newer');
  });

  it('returns null when every row is superseded (or none exist)', () => {
    expect(pickCurrentArtifact([])).toBeNull();
    expect(pickCurrentArtifact([artifactRow({ superseded_at: 'T' })])).toBeNull();
  });
});

describe('promoteUnits', () => {
  it('parses the artifact with parseBoltDag and writes the UNITPLAN + UNIT rows (scheduling truth)', async () => {
    const res = await promoteUnits(basePayload, deps);
    expect(res).toMatchObject({ ok: true, unitCount: 3, batchCount: 2 });

    expect(store.putUnitPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        executionId: 'e1',
        units: [
          { slug: 'auth', dependsOn: [] },
          { slug: 'catalog', dependsOn: [] },
          { slug: 'checkout', dependsOn: ['auth', 'catalog'] },
        ],
        batches: [['auth', 'catalog'], ['checkout']],
        sourceArtifactId: 'art-dag-1',
        producedByStageInstanceId: 'si-units',
        // Deterministic defaults, pending the WP5 fan-out gate.
        skipMatrix: {},
        walkingSkeleton: 'auth',
        autonomyMode: null,
      }),
    );
    expect(store.syncUnitRows).toHaveBeenCalledWith(expect.objectContaining({ executionId: 'e1' }));
    expect(res.walkingSkeleton).toBe('auth');
  });

  it('mirrors the DAG to the graph and reports the mirror result', async () => {
    const res = await promoteUnits(basePayload, deps);
    expect(writer.mirrorUnitDag).toHaveBeenCalledWith({
      units: [
        { slug: 'auth', dependsOn: [] },
        { slug: 'catalog', dependsOn: [] },
        { slug: 'checkout', dependsOn: ['auth', 'catalog'] },
      ],
      sourceArtifactId: 'art-dag-1',
    });
    expect(res.mirror).toEqual({ mirrored: 3, superseded: 0 });
  });

  it('records a v2.units.promoted event and broadcasts agent.units', async () => {
    await promoteUnits(basePayload, deps);
    const evTypes = store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.units.promoted');
    const summary = store.appendEvent.mock.calls.find((c) => c[0].type === 'v2.units.promoted')[0]
      .summary;
    expect(summary).toContain('3 unit(s) in 2 wave(s)');
    expect(deps.broadcast).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'agent.units', unitCount: 3, state: 'PROMOTED' }),
    );
  });

  it('a mirror failure never blocks promotion — DDB truth is written, mirror_failed recorded', async () => {
    writer.mirrorUnitDag = vi.fn(async () => {
      throw new Error('neptune unavailable');
    });
    const res = await promoteUnits(basePayload, deps);
    expect(res.ok).toBe(true);
    expect(res.mirror).toBeNull();
    const evTypes = store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.units.mirror_failed');
    expect(evTypes).toContain('v2.units.promoted');
  });

  it('re-promotion preserves previously captured human decisions', async () => {
    store.getUnitPlan = vi.fn(async () => ({
      skipMatrix: { checkout: ['nfr-design'] },
      walkingSkeleton: 'catalog',
      autonomyMode: 'autonomous',
    }));
    await promoteUnits(basePayload, deps);
    expect(store.putUnitPlan).toHaveBeenCalledWith(
      expect.objectContaining({
        skipMatrix: { checkout: ['nfr-design'] },
        walkingSkeleton: 'catalog',
        autonomyMode: 'autonomous',
      }),
    );
  });

  it('skips superseded artifact rows (rewind produces a fresh one)', async () => {
    writer.lookupArtifacts = vi.fn(async () => [
      artifactRow({ id: 'retired', superseded_at: 'T2' }),
      artifactRow({ id: 'current', created_at: '2026-02-01T00:00:00Z' }),
    ]);
    const res = await promoteUnits(basePayload, deps);
    expect(res.ok).toBe(true);
    expect(store.putUnitPlan).toHaveBeenCalledWith(
      expect.objectContaining({ sourceArtifactId: 'current' }),
    );
  });

  it('fails with artifact_not_found when no current DAG artifact exists', async () => {
    writer.lookupArtifacts = vi.fn(async () => []);
    const res = await promoteUnits(basePayload, deps);
    expect(res).toMatchObject({ ok: false, reason: 'artifact_not_found' });
    expect(store.putUnitPlan).not.toHaveBeenCalled();
    const evTypes = store.appendEvent.mock.calls.map((c) => c[0].type);
    expect(evTypes).toContain('v2.units.promotion_failed');
  });

  it('fails with the parser reason for a malformed DAG body', async () => {
    writer.lookupArtifacts = vi.fn(async () => [artifactRow({ content: 'no yaml here' })]);
    const res = await promoteUnits(basePayload, deps);
    expect(res).toMatchObject({ ok: false, reason: 'dag_absent' });
    expect(store.putUnitPlan).not.toHaveBeenCalled();
  });

  it('fails with dag_cyclic for a dependency cycle', async () => {
    const cyclic =
      '```yaml\nunits:\n  - name: a\n    depends_on: [b]\n  - name: b\n    depends_on: [a]\n```';
    writer.lookupArtifacts = vi.fn(async () => [artifactRow({ content: cyclic })]);
    const res = await promoteUnits(basePayload, deps);
    expect(res).toMatchObject({ ok: false, reason: 'dag_cyclic' });
  });

  it('fails with promotion_failed when the graph is unreachable', async () => {
    deps.openGraph = vi.fn(async () => {
      throw new Error('vpc timeout');
    });
    const res = await promoteUnits(basePayload, deps);
    expect(res).toMatchObject({ ok: false, reason: 'promotion_failed' });
    expect(res.detail).toContain('vpc timeout');
  });

  it('fails with promotion_failed when the DDB write throws (no partial silent success)', async () => {
    store.putUnitPlan = vi.fn(async () => {
      throw new Error('ddb throttled');
    });
    const res = await promoteUnits(basePayload, deps);
    expect(res).toMatchObject({ ok: false, reason: 'promotion_failed', detail: 'ddb throttled' });
  });

  it('refuses a payload without identity', async () => {
    const res = await promoteUnits({ executionId: 'e1' }, deps);
    expect(res).toMatchObject({ ok: false, reason: 'missing_identity' });
  });
});
