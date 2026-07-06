import type { CompiledWorkflow } from '@/services/workflows';

export { isExecuteInScope } from '@/lib/scope-utils';

export const PHASE_PALETTE = ['#94a3b8', '#6366f1', '#f59e0b', '#10b981', '#ec4899'] as const;

export const PHASE_COLORS: Record<string, string> = {
  '00': '#94a3b8',
  '01': '#6366f1',
  '02': '#f59e0b',
  '03': '#10b981',
  '04': '#ec4899',
};

export const PHASE_LABELS: Record<string, string> = {
  '00': '0 · Init',
  '01': '1 · Ideation',
  '02': '2 · Inception',
  '03': '3 · Construction',
  '04': '4 · Operation',
};

export const PHASE_ORDER = ['00', '01', '02', '03', '04'] as const;

const COL_W = 320;
const COL_GAP = 24;
const ROW_H = 60;
const ROW_GAP = 10;
export const NODE_W = 300;
export const NODE_H = 52;
const PAD_TOP = 40;
const PAD_LEFT = 20;

export interface PhaseInput {
  path: string;
  name: string;
}

export interface NodePosition {
  x: number;
  y: number;
  stageId: string;
  phasePath: string;
}

export interface LayoutResult {
  positions: Map<string, NodePosition>;
  width: number;
  height: number;
  phaseColumns: { phasePath: string; name: string; x: number; colWidth: number }[];
}

const FALLBACK_PATH = '__other__';

export function computeLayout(
  nodes: CompiledWorkflow['graph']['nodes'],
  phases: PhaseInput[],
): LayoutResult {
  const sorted = phases.toSorted((a, b) => a.path.localeCompare(b.path));
  const phasePathSet = new Set(sorted.map((p) => p.path));

  const byPhase = new Map<string, CompiledWorkflow['graph']['nodes']>();
  for (const p of sorted) byPhase.set(p.path, []);
  byPhase.set(FALLBACK_PATH, []);

  for (const node of nodes) {
    const key = node.phasePath && phasePathSet.has(node.phasePath) ? node.phasePath : FALLBACK_PATH;
    byPhase.get(key)!.push(node);
  }

  for (const [key, list] of byPhase) {
    byPhase.set(
      key,
      list.toSorted((a, b) => a.order - b.order),
    );
  }

  const fallbackNodes = byPhase.get(FALLBACK_PATH)!;
  const columnsToRender: PhaseInput[] = [...sorted];
  if (fallbackNodes.length > 0) {
    columnsToRender.push({ path: FALLBACK_PATH, name: '—' });
  }

  const positions = new Map<string, NodePosition>();
  let maxRows = 0;
  const phaseColumns: LayoutResult['phaseColumns'] = [];

  for (let ci = 0; ci < columnsToRender.length; ci++) {
    const col = columnsToRender[ci];
    const list = byPhase.get(col.path) ?? [];
    if (list.length > maxRows) maxRows = list.length;

    const colX = PAD_LEFT + ci * (COL_W + COL_GAP);
    phaseColumns.push({ phasePath: col.path, name: col.name, x: colX, colWidth: COL_W });

    for (let ri = 0; ri < list.length; ri++) {
      const node = list[ri];
      positions.set(node.stageId, {
        x: colX,
        y: PAD_TOP + ri * (ROW_H + ROW_GAP),
        stageId: node.stageId,
        phasePath: col.path,
      });
    }
  }

  const colCount = columnsToRender.length;
  const width = PAD_LEFT + colCount * COL_W + (colCount - 1) * COL_GAP + PAD_LEFT;
  const height = PAD_TOP + maxRows * (ROW_H + ROW_GAP) + 14;

  return { positions, width, height, phaseColumns };
}

export function paletteColorForIndex(index: number): string {
  return PHASE_PALETTE[index % PHASE_PALETTE.length];
}

export function cubicEdgePath(from: NodePosition, to: NodePosition, offset = 0): string {
  const x1 = from.x + NODE_W;
  const y1 = from.y + NODE_H / 2;
  const x2 = to.x;
  const y2 = to.y + NODE_H / 2;
  const dx = (x2 - x1) * 0.5;
  // `offset` bows the curve so multiple edges between the same pair of stages
  // (V2 emits one edge per artifact/kind) fan out instead of stacking.
  return `M ${x1} ${y1} C ${x1 + dx} ${y1 + offset}, ${x2 - dx} ${y2 + offset}, ${x2} ${y2}`;
}

export function countScopeStats(
  scopeGrid: Record<string, Record<string, 'EXECUTE' | 'SKIP'>>,
  edges: CompiledWorkflow['graph']['edges'],
  scopeId: string,
  totalStages: number,
): { executeCount: number; liveEdges: number; total: number } {
  const executeSet = new Set<string>();
  for (const node of Object.keys(scopeGrid[scopeId] ?? {})) {
    if (scopeGrid[scopeId][node] === 'EXECUTE') executeSet.add(node);
  }

  if (executeSet.size === 0) {
    const innerKeys = Object.keys(scopeGrid);
    for (const stageKey of innerKeys) {
      if (scopeGrid[stageKey]?.[scopeId] === 'EXECUTE') executeSet.add(stageKey);
    }
  }

  let liveEdges = 0;
  for (const edge of edges) {
    if (executeSet.has(edge.from) && executeSet.has(edge.to)) liveEdges++;
  }

  return { executeCount: executeSet.size, liveEdges, total: totalStages };
}
