import { useMemo } from 'react';
import { cn } from '@/lib/utils';
import { useIntent, type IntentStageRow, type StageEdge } from '@/contexts/IntentContext';
import { StageBadge } from '@/components/intent/stageStyle';
import { StageDetail } from '@/components/intent/StageDetail';

// Purpose-built topological pipeline DAG for a v2 intent (5–20 nodes). The v1
// SprintGraph engine is deliberately NOT reused: its layouts (force physics,
// type-hierarchy) don't express dependency order, which is the whole point of
// a stage pipeline. Deterministic columns = dependency depth; HTML nodes over
// an SVG edge layer so state styling matches the list exactly.

const NODE_W = 176;
const NODE_H = 56;
const GAP_X = 72;
const GAP_Y = 14;
const PAD = 12;

// Longest-path (Kahn) layering: a stage's column is 1 + the deepest of its
// dependencies. Cycle leftovers (compiled.graph.cycles flags them) append as a
// final column in plan order so the graph is still complete.
export function layerStages(rows: IntentStageRow[], edges: StageEdge[]): IntentStageRow[][] {
  const byId = new Map(rows.map((r) => [r.stageId, r]));
  const deps = new Map<string, Set<string>>(rows.map((r) => [r.stageId, new Set()]));
  for (const e of edges) {
    if (byId.has(e.from) && byId.has(e.to) && e.from !== e.to) deps.get(e.to)!.add(e.from);
  }
  const layer = new Map<string, number>();
  const remaining = new Set(byId.keys());
  while (remaining.size > 0) {
    const ready = [...remaining].filter((id) =>
      [...deps.get(id)!].every((d) => layer.has(d) || !remaining.has(d)),
    );
    if (ready.length === 0) break; // cycle — leftovers handled below
    for (const id of ready) {
      const ds = [...deps.get(id)!].map((d) => layer.get(d) ?? 0);
      layer.set(id, ds.length ? Math.max(...ds) + 1 : 0);
      remaining.delete(id);
    }
  }
  const maxLayer = layer.size ? Math.max(...layer.values()) : -1;
  for (const id of remaining) layer.set(id, maxLayer + 1);

  const columns: IntentStageRow[][] = [];
  for (const [id, l] of layer) {
    (columns[l] ??= []).push(byId.get(id)!);
  }
  const dense = columns.filter((c) => c && c.length > 0);
  for (const col of dense) {
    col.sort((a, b) => a.order - b.order || a.stageId.localeCompare(b.stageId));
  }
  return dense;
}

interface NodePos {
  row: IntentStageRow;
  x: number;
  y: number;
}

export function IntentGraph() {
  const { stageRows, stageEdges, detail, selectedStageId, setSelectedStageId } = useIntent();

  const { positions, width, height } = useMemo(() => {
    const columns = layerStages(stageRows, stageEdges);
    const maxRows = Math.max(1, ...columns.map((c) => c.length));
    const maxColH = maxRows * NODE_H + (maxRows - 1) * GAP_Y;
    const pos = new Map<string, NodePos>();
    columns.forEach((col, ci) => {
      const colH = col.length * NODE_H + (col.length - 1) * GAP_Y;
      const yStart = PAD + (maxColH - colH) / 2;
      col.forEach((row, ri) => {
        pos.set(row.stageId, {
          row,
          x: PAD + ci * (NODE_W + GAP_X),
          y: yStart + ri * (NODE_H + GAP_Y),
        });
      });
    });
    return {
      positions: pos,
      width: PAD * 2 + columns.length * NODE_W + Math.max(0, columns.length - 1) * GAP_X,
      height: PAD * 2 + maxColH,
    };
  }, [stageRows, stageEdges]);

  const selectedRow = selectedStageId
    ? (stageRows.find((r) => r.stageId === selectedStageId) ?? null)
    : null;

  // Parallel edges between one stage pair (several artifacts, or data +
  // requires) collapse into one drawn curve with a combined label.
  const drawnEdges = useMemo(() => {
    const m = new Map<string, { from: string; to: string; data: boolean; artifacts: string[] }>();
    for (const e of stageEdges) {
      const key = `${e.from}→${e.to}`;
      const g = m.get(key) ?? { from: e.from, to: e.to, data: false, artifacts: [] };
      if (e.kind === 'data') g.data = true;
      if (e.artifact && !g.artifacts.includes(e.artifact)) g.artifacts.push(e.artifact);
      m.set(key, g);
    }
    return [...m.values()];
  }, [stageEdges]);

  if (stageRows.length === 0) {
    return <p className="text-sm text-muted-foreground">No stages resolved yet.</p>;
  }

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto rounded-md border bg-muted/10">
        <div className="relative" style={{ width, height }}>
          {/* Edge layer */}
          <svg
            width={width}
            height={height}
            className="absolute inset-0 text-muted-foreground"
            aria-hidden
          >
            <defs>
              <marker
                id="intent-graph-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="6"
                markerHeight="6"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
              </marker>
            </defs>
            {drawnEdges.map((e) => {
              const from = positions.get(e.from);
              const to = positions.get(e.to);
              if (!from || !to) return null;
              const x1 = from.x + NODE_W;
              const y1 = from.y + NODE_H / 2;
              const x2 = to.x;
              const y2 = to.y + NODE_H / 2;
              const bend = Math.max(24, (x2 - x1) / 2);
              const touchesSelected = e.from === selectedStageId || e.to === selectedStageId;
              return (
                <g
                  key={`${e.from}→${e.to}`}
                  className={cn(touchesSelected && 'text-primary')}
                  opacity={touchesSelected ? 0.9 : 0.45}
                >
                  <path
                    d={`M ${x1} ${y1} C ${x1 + bend} ${y1}, ${x2 - bend} ${y2}, ${x2} ${y2}`}
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={1.5}
                    strokeDasharray={e.data ? undefined : '4 3'}
                    markerEnd="url(#intent-graph-arrow)"
                  />
                  {e.artifacts.length > 0 && (
                    <text
                      x={(x1 + x2) / 2}
                      y={(y1 + y2) / 2 - 5}
                      textAnchor="middle"
                      fontSize="9"
                      fill="currentColor"
                    >
                      {e.artifacts.join(', ')}
                    </text>
                  )}
                </g>
              );
            })}
          </svg>

          {/* Node layer */}
          {[...positions.values()].map(({ row, x, y }) => {
            const current = row.stageId === detail?.intent.currentStage;
            const selected = row.stageId === selectedStageId;
            return (
              <button
                key={row.stageId}
                type="button"
                title={row.stageId}
                onClick={() => setSelectedStageId(selected ? null : row.stageId)}
                style={{ left: x, top: y, width: NODE_W, height: NODE_H }}
                className={cn(
                  'absolute flex flex-col justify-center gap-1 rounded-md border bg-card px-2.5 py-1.5 text-left shadow-sm transition-colors hover:bg-muted/40',
                  current && 'border-primary/50 bg-primary/[0.04]',
                  selected && 'ring-2 ring-primary',
                )}
              >
                <span className="truncate text-xs font-medium">{row.stageId}</span>
                <span className="flex items-center">
                  <StageBadge state={row.state} />
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Shared drill-down (same as the list rows) */}
      {selectedRow && (
        <div>
          <div className="rounded-t-md border border-b-0 bg-muted/30 px-3 py-1.5 text-xs font-medium">
            {selectedRow.stageId}
          </div>
          <StageDetail row={selectedRow} />
        </div>
      )}
    </div>
  );
}
