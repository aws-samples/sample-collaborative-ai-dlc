import type { CompiledWorkflow } from '@/services/workflows';
import type { StageState } from '@/services/intents';

/** Phase column input: path + display name. */
export interface PhaseInput {
  path: string;
  name: string;
}

// ── Unit-lane graph layout (observability only) ──────────────────────────────
// Standalone from the composer graph (scope-graph-utils / WorkflowScopeGraph):
// it owns its OWN dimensions so tuning this screen never touches the other.
// Expands the fan-out phase into sub-columns: pre-fan-out stages, a synthetic
// unit-node column, a per-unit stage-lane column (unit blocks stacked
// vertically), and post-fan-out stages. All other phases lay out as normal.

export const NODE_W = 225;
export const NODE_H = 40;
export const UNIT_NODE_W = 140;
const COL_W = NODE_W + 20;
const UNIT_COL_W = 150;
const COL_GAP = 24;
const ROW_H = 48;
const ROW_GAP = 10;
const PAD_TOP = 40;
const PAD_LEFT = 20;
const FALLBACK_PATH = '__other__';

export interface UnitLaneStageCell {
  stageId: string;
  stageInstanceId: string | null;
  state: StageState;
  synthesized: boolean;
  rowKey: string | null;
}

export interface UnitLane {
  slug: string;
  state: string | null;
  stages: UnitLaneStageCell[];
}

export interface UnitLanesInput {
  units: UnitLane[];
  /** Fan-out stage ids for the (single) parallel section, in plan order. */
  sectionStageIds: string[];
}

export type UnitNodeKind = 'stage' | 'unit' | 'unitStage';

export interface UnitLaneNode {
  key: string;
  kind: UnitNodeKind;
  x: number;
  y: number;
  phasePath: string;
  // 'stage' nodes: the plan stage. 'unit'/'unitStage' carry slug (+ stageId).
  stageId?: string;
  slug?: string;
  state?: StageState;
  unitState?: string | null;
  synthesized?: boolean;
  rowKey?: string | null;
}

export interface UnitLaneEdge {
  from: string; // node key
  to: string; // node key
  // 'vertical' = same-column stage→stage progression within a unit (draw as a
  // short vertical connector); otherwise a normal left→right cubic edge.
  vertical?: boolean;
  // For pass-through edges carried over from the compiled graph (data/requires/
  // blocks between plain stages) so the renderer can style them like the normal
  // graph. Synthetic lane edges leave this undefined.
  kind?: string;
}

export interface UnitLaneLayout {
  nodes: Map<string, UnitLaneNode>;
  edges: UnitLaneEdge[];
  width: number;
  height: number;
  phaseColumns: { phasePath: string; name: string; x: number; colWidth: number }[];
}

/**
 * Layout for the observability graph when unit lanes are present. Keeps every
 * node stacked vertically (like the other phase columns); the fan-out phase is
 * widened into pre | unit | lane | post sub-columns. Returns null when the input
 * is unsupported (no fan-out stages, no units).
 */
export function computeUnitLaneLayout(
  nodes: CompiledWorkflow['graph']['nodes'],
  phases: PhaseInput[],
  lanes: UnitLanesInput,
  compiledEdges: CompiledWorkflow['graph']['edges'] = [],
): UnitLaneLayout | null {
  const sectionSet = new Set(lanes.sectionStageIds);
  if (sectionSet.size === 0 || lanes.units.length === 0) return null;

  // The fan-out phase is the phase of the section's stages.
  const sectionNode = nodes.find((n) => sectionSet.has(n.stageId));
  const fanoutPhase = sectionNode?.phasePath ?? null;
  if (!fanoutPhase) return null;

  const sorted = phases.toSorted((a, b) => a.path.localeCompare(b.path));
  const phasePathSet = new Set(sorted.map((p) => p.path));

  // The fan-out phase must be one of the provided phase columns; otherwise it
  // would fall into the `__other__` bucket and the lane band would never render
  // (happens transiently while workflow phase metadata is still loading).
  if (!phasePathSet.has(fanoutPhase)) return null;

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
  // Drop empty phase columns (e.g. Ideation/Operation with no in-scope stages)
  // so they don't render as dead space — but always keep the fan-out phase.
  const columnsToRender: PhaseInput[] = sorted.filter(
    (p) => p.path === fanoutPhase || (byPhase.get(p.path)?.length ?? 0) > 0,
  );
  if (fallbackNodes.length > 0) columnsToRender.push({ path: FALLBACK_PATH, name: '—' });

  const nodesOut = new Map<string, UnitLaneNode>();
  const edges: UnitLaneEdge[] = [];
  const phaseColumns: UnitLaneLayout['phaseColumns'] = [];
  let cursorX = PAD_LEFT;
  let maxBottom = PAD_TOP;

  const rowY = (ri: number) => PAD_TOP + ri * (ROW_H + ROW_GAP);

  for (const col of columnsToRender) {
    const list = byPhase.get(col.path) ?? [];

    if (col.path !== fanoutPhase) {
      // Normal single-column phase.
      const colX = cursorX;
      list.forEach((node, ri) => {
        nodesOut.set(node.stageId, {
          key: node.stageId,
          kind: 'stage',
          x: colX,
          y: rowY(ri),
          phasePath: col.path,
          stageId: node.stageId,
        });
      });
      phaseColumns.push({ phasePath: col.path, name: col.name, x: colX, colWidth: COL_W });
      maxBottom = Math.max(maxBottom, rowY(Math.max(list.length, 1) - 1) + NODE_H);
      cursorX = colX + COL_W + COL_GAP;
      continue;
    }

    // Fan-out phase: split into pre | unit | lane | post sub-columns.
    const pre = list.filter(
      (n) => !sectionSet.has(n.stageId) && isBeforeSection(n, list, sectionSet),
    );
    const post = list.filter(
      (n) => !sectionSet.has(n.stageId) && !isBeforeSection(n, list, sectionSet),
    );

    const bandX = cursorX;
    const preX = bandX;
    const unitX = preX + (pre.length > 0 ? COL_W + COL_GAP : 0);
    const laneX = unitX + UNIT_COL_W + COL_GAP;
    const postX = laneX + COL_W + COL_GAP;

    pre.forEach((node, ri) => {
      nodesOut.set(node.stageId, {
        key: node.stageId,
        kind: 'stage',
        x: preX,
        y: rowY(ri),
        phasePath: col.path,
        stageId: node.stageId,
      });
    });

    // Lane column: unit blocks stacked; each block = the unit's stages in order.
    let laneRow = 0;
    lanes.units.forEach((unit) => {
      const blockTop = laneRow;
      const unitKey = `unit:${unit.slug}`;
      let prevCellKey: string | null = null;
      unit.stages.forEach((cell, ci) => {
        const key = `stage:${cell.stageId}:${unit.slug}`;
        nodesOut.set(key, {
          key,
          kind: 'unitStage',
          x: laneX,
          y: rowY(laneRow),
          phasePath: col.path,
          stageId: cell.stageId,
          slug: unit.slug,
          state: cell.state,
          synthesized: cell.synthesized,
          rowKey: cell.rowKey,
        });
        // unit node → first cell; then cell → next cell (the per-unit stage
        // progression, e.g. func-design → nfr-design → code-generation).
        if (ci === 0) edges.push({ from: unitKey, to: key });
        else if (prevCellKey) edges.push({ from: prevCellKey, to: key, vertical: true });
        prevCellKey = key;
        laneRow += 1;
      });
      // Synthetic unit node aligned to the vertical centre of its block.
      const blockBottom = laneRow - 1;
      const unitY = rowY((blockTop + blockBottom) / 2);
      nodesOut.set(unitKey, {
        key: unitKey,
        kind: 'unit',
        x: unitX,
        y: unitY,
        phasePath: col.path,
        slug: unit.slug,
        unitState: unit.state,
      });
      // Small gap between unit blocks.
      laneRow += 1;
    });
    const laneRowsUsed = Math.max(laneRow - 1, 1);

    // Post stages (build-and-test) — link the last stage of every unit into
    // each post stage so the fan-in reads visually.
    post.forEach((node, ri) => {
      nodesOut.set(node.stageId, {
        key: node.stageId,
        kind: 'stage',
        x: postX,
        y: rowY(ri),
        phasePath: col.path,
        stageId: node.stageId,
      });
      for (const unit of lanes.units) {
        const last = unit.stages[unit.stages.length - 1];
        if (last) edges.push({ from: `stage:${last.stageId}:${unit.slug}`, to: node.stageId });
      }
    });

    const bandWidth = postX + (post.length > 0 ? COL_W : 0) - bandX;
    phaseColumns.push({ phasePath: col.path, name: col.name, x: bandX, colWidth: bandWidth });
    maxBottom = Math.max(maxBottom, rowY(laneRowsUsed) + NODE_H);
    cursorX = bandX + bandWidth + COL_GAP;
  }

  const width = cursorX - COL_GAP + PAD_LEFT;
  const height = maxBottom + 14;

  // Carry over the compiled dependency edges (data/requires/blocks). A fan-out
  // stage has no single node (it is N per-unit cells), so edges touching one are
  // REMAPPED per unit rather than dropped: an edge INTO the section targets each
  // unit node (upstream feeds every unit); an edge OUT of the section starts at
  // each unit's LAST cell (the fan-in). Edges wholly inside the section (fan-out
  // → fan-out) are already the per-unit vertical progression — skip.
  const unitSlugs = lanes.units.map((u) => u.slug);
  const lastCellKeyOf = (slug: string): string | null => {
    const u = lanes.units.find((x) => x.slug === slug);
    const last = u?.stages[u.stages.length - 1];
    return last ? `stage:${last.stageId}:${slug}` : null;
  };
  for (const e of compiledEdges) {
    const fromFanout = sectionSet.has(e.from);
    const toFanout = sectionSet.has(e.to);
    if (fromFanout && toFanout) continue; // internal progression, already drawn

    if (!fromFanout && toFanout) {
      // upstream → each unit node
      if (!nodesOut.has(e.from)) continue;
      for (const slug of unitSlugs) edges.push({ from: e.from, to: `unit:${slug}`, kind: e.kind });
      continue;
    }
    if (fromFanout && !toFanout) {
      // each unit's last cell → downstream
      if (!nodesOut.has(e.to)) continue;
      for (const slug of unitSlugs) {
        const last = lastCellKeyOf(slug);
        if (last) edges.push({ from: last, to: e.to, kind: e.kind });
      }
      continue;
    }
    // plain → plain
    if (nodesOut.has(e.from) && nodesOut.has(e.to)) {
      edges.push({ from: e.from, to: e.to, kind: e.kind });
    }
  }

  // Dedup edges by endpoint pair (the structural fan-in edges added in the post
  // loop can coincide with a remapped compiled edge). Prefer the entry that
  // carries a `kind`/`vertical` flag so styling survives.
  const edgeByPair = new Map<string, UnitLaneEdge>();
  for (const e of edges) {
    const pk = `${e.from}->${e.to}`;
    const existing = edgeByPair.get(pk);
    if (!existing || (existing.kind === undefined && e.kind !== undefined)) {
      edgeByPair.set(pk, e);
    }
  }

  return { nodes: nodesOut, edges: [...edgeByPair.values()], width, height, phaseColumns };
}

// A fan-out phase stage is "before" the section if its plan order is below the
// smallest section-stage order (else it is a post/fan-in stage).
function isBeforeSection(
  node: CompiledWorkflow['graph']['nodes'][number],
  phaseNodes: CompiledWorkflow['graph']['nodes'],
  sectionSet: Set<string>,
): boolean {
  let minSectionOrder = Number.MAX_SAFE_INTEGER;
  for (const n of phaseNodes) {
    if (sectionSet.has(n.stageId)) minSectionOrder = Math.min(minSectionOrder, n.order);
  }
  return node.order < minSectionOrder;
}
