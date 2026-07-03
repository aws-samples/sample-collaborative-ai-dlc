import { useState, useMemo } from 'react';
import type { CompiledWorkflow } from '@/services/workflows';
import {
  computeLayout,
  cubicEdgePath,
  isExecuteInScope,
  paletteColorForIndex,
  PHASE_ORDER,
  PHASE_LABELS,
  NODE_W,
  NODE_H,
  type PhaseInput,
} from './scope-graph-utils';
import { Button } from '@/components/ui/button';

export interface WorkflowScopeGraphProps {
  compiled: CompiledWorkflow;
  scopes?: string[];
  phases?: PhaseInput[];
  defaultScope?: string;
  stageMeta?: Record<string, { number: string; name: string; phase: string }>;
  scopeDescriptions?: Record<string, string>;
  readOnly?: boolean;
  onToggleScope?: (stageId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => void;
}

const EDGE_STYLES: Record<
  string,
  { width: number; dash: string; color: string; dimColor: string }
> = {
  data: {
    width: 1.5,
    dash: '4 3',
    color: 'var(--border)',
    dimColor: 'var(--muted-foreground)',
  },
  requires: {
    width: 2,
    dash: '',
    color: 'var(--border)',
    dimColor: 'var(--muted-foreground)',
  },
  blocks: {
    width: 3,
    dash: '',
    color: 'var(--destructive)',
    dimColor: 'var(--muted-foreground)',
  },
};

function deriveScopeList(
  scopeGrid: Record<string, Record<string, 'EXECUTE' | 'SKIP'>>,
  graphNodeIds: Set<string>,
): string[] {
  const scopes: string[] = [];
  for (const key of Object.keys(scopeGrid)) {
    if (!graphNodeIds.has(key)) scopes.push(key);
  }
  if (scopes.length > 0) return scopes;
  const inner = Object.values(scopeGrid)[0];
  if (inner) return Object.keys(inner);
  return [];
}

function pickDefaultScope(
  scopeList: string[],
  scopeGrid: Record<string, Record<string, 'EXECUTE' | 'SKIP'>>,
): string {
  let best = scopeList[0] ?? '';
  let bestCount = -1;
  for (const scope of scopeList) {
    const row = scopeGrid[scope] ?? {};
    const count = Object.values(row).filter((v) => v === 'EXECUTE').length;
    if (count > bestCount) {
      best = scope;
      bestCount = count;
    }
  }
  return best;
}

function truncateName(name: string, max = 26): string {
  return name.length > max ? name.slice(0, max - 1) + '…' : name;
}

function defaultPhaseList(): PhaseInput[] {
  return PHASE_ORDER.map((p) => ({ path: p, name: PHASE_LABELS[p] }));
}

export function WorkflowScopeGraph({
  compiled,
  scopes: scopesProp,
  phases: phasesProp,
  defaultScope,
  stageMeta: stageMetaProp,
  scopeDescriptions: scopeDescProp,
  readOnly,
  onToggleScope,
}: WorkflowScopeGraphProps) {
  const graphNodeIds = useMemo(
    () => new Set(compiled.graph.nodes.map((n) => n.stageId)),
    [compiled],
  );

  const scopeList = useMemo(
    () => scopesProp ?? deriveScopeList(compiled.scopeGrid, graphNodeIds),
    [scopesProp, compiled.scopeGrid, graphNodeIds],
  );

  const [activeScope, setActiveScope] = useState(
    () => defaultScope ?? pickDefaultScope(scopeList, compiled.scopeGrid),
  );

  const phaseList = useMemo(() => phasesProp ?? defaultPhaseList(), [phasesProp]);

  const layout = useMemo(
    () => computeLayout(compiled.graph.nodes, phaseList),
    [compiled.graph.nodes, phaseList],
  );

  const colorByPath = useMemo(() => {
    const map: Record<string, string> = {};
    const sorted = phaseList.toSorted((a, b) => a.path.localeCompare(b.path));
    sorted.forEach((p, i) => {
      map[p.path] = paletteColorForIndex(i);
    });
    map['__other__'] = '#cbd5e1';
    return map;
  }, [phaseList]);

  const meta = stageMetaProp ?? {};
  const descriptions = scopeDescProp ?? {};
  const editable = !readOnly && !!onToggleScope;

  const executeSet = useMemo(() => {
    const set = new Set<string>();
    for (const node of compiled.graph.nodes) {
      if (isExecuteInScope(compiled.scopeGrid, node.stageId, activeScope)) set.add(node.stageId);
    }
    return set;
  }, [compiled, activeScope]);

  const liveEdges = useMemo(
    () => compiled.graph.edges.filter((e) => executeSet.has(e.from) && executeSet.has(e.to)).length,
    [compiled.graph.edges, executeSet],
  );
  const totalStages = compiled.graph.nodes.length;

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-1.5">
        {scopeList.map((scope) => (
          <Button
            key={scope}
            variant={scope === activeScope ? 'secondary' : 'ghost'}
            size="sm"
            className="h-7 px-2.5 text-xs"
            onClick={() => setActiveScope(scope)}
          >
            {scope}
          </Button>
        ))}
      </div>

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          className="w-full rounded border border-border bg-card/50 block"
        >
          {layout.phaseColumns.map(({ phasePath, name: colName, x, colWidth }) => (
            <g key={phasePath}>
              <rect
                x={x - 5}
                y={18}
                width={colWidth + 10}
                height={layout.height - 20}
                rx={6}
                fill="var(--muted)"
                opacity={0.3}
              />
              <text
                x={x + colWidth / 2}
                y={16}
                textAnchor="middle"
                fill="var(--muted-foreground)"
                className="text-[11px] font-medium"
              >
                {colName}
              </text>
            </g>
          ))}

          {(() => {
            const pairSeen = new Map<string, number>();
            const pairTotal = new Map<string, number>();
            for (const edge of compiled.graph.edges) {
              const pk = `${edge.from}->${edge.to}`;
              pairTotal.set(pk, (pairTotal.get(pk) ?? 0) + 1);
            }
            return compiled.graph.edges.map((edge) => {
              const from = layout.positions.get(edge.from);
              const to = layout.positions.get(edge.to);
              if (!from || !to) return null;
              const live = executeSet.has(edge.from) && executeSet.has(edge.to);
              const style = EDGE_STYLES[edge.kind] ?? EDGE_STYLES.requires;
              const pk = `${edge.from}->${edge.to}`;
              const total = pairTotal.get(pk) ?? 1;
              const idx = pairSeen.get(pk) ?? 0;
              pairSeen.set(pk, idx + 1);
              const offset = total > 1 ? (idx - (total - 1) / 2) * 14 : 0;
              return (
                <path
                  key={`${pk}:${edge.kind}:${edge.artifact ?? ''}:${idx}`}
                  d={cubicEdgePath(from, to, offset)}
                  fill="none"
                  stroke={live ? style.color : style.dimColor}
                  strokeWidth={style.width}
                  strokeDasharray={style.dash}
                  opacity={live ? 0.85 : 0.18}
                />
              );
            });
          })()}

          {compiled.graph.nodes.map((node) => {
            const pos = layout.positions.get(node.stageId);
            if (!pos) return null;
            const inScope = executeSet.has(node.stageId);
            const fill = inScope ? (colorByPath[pos.phasePath] ?? '#94a3b8') : '#cbd5e1';
            const textFill = inScope ? '#ffffff' : '#475569';
            const stageInfo = meta[node.stageId];
            const displayNum = stageInfo?.number ?? '';
            const displayName = truncateName(stageInfo?.name ?? node.stageId, 30);
            return (
              <g
                key={node.stageId}
                transform={`translate(${pos.x},${pos.y})`}
                opacity={inScope ? 1 : 0.6}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={fill}
                  stroke="none"
                  strokeWidth={0}
                />
                <text
                  x={10}
                  y={32}
                  fill={textFill}
                  className="text-[11px] font-bold"
                  opacity={inScope ? 0.8 : 0.85}
                >
                  {displayNum}
                </text>
                <text x={34} y={32} fill={textFill} className="text-[13px]">
                  {displayName}
                </text>
                <g
                  transform={`translate(${NODE_W - 50}, ${NODE_H / 2 - 9})`}
                  style={editable && activeScope ? { cursor: 'pointer' } : undefined}
                  onClick={
                    editable && activeScope
                      ? (e) => {
                          e.stopPropagation();
                          onToggleScope(node.stageId, activeScope, inScope ? 'SKIP' : 'EXECUTE');
                        }
                      : undefined
                  }
                >
                  <rect
                    width={42}
                    height={18}
                    rx={9}
                    fill={inScope ? '#10b981' : '#94a3b8'}
                    opacity={inScope ? 0.9 : 0.7}
                  />
                  <text
                    x={21}
                    y={13}
                    textAnchor="middle"
                    fill={inScope ? '#ffffff' : '#e2e8f0'}
                    className="text-[8px] font-semibold"
                  >
                    {inScope ? 'EXEC' : 'SKIP'}
                  </text>
                </g>
              </g>
            );
          })}
        </svg>
      </div>

      <p className="text-xs text-muted-foreground">
        <span className="font-semibold text-foreground">{activeScope}</span>
        {' · '}
        <em>{descriptions[activeScope] ?? ''}</em>
        {'. '}
        {executeSet.size} of {totalStages} stages run; {liveEdges} edges live within scope.
        {editable && ' · Toggle the EXEC/SKIP switch on a stage to include it in this scope.'}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
        {layout.phaseColumns
          .filter((c) => c.phasePath !== '__other__')
          .map((col) => (
            <span key={col.phasePath} className="flex items-center gap-1">
              <span
                className="inline-block h-2.5 w-4 rounded-sm"
                style={{ background: colorByPath[col.phasePath] }}
              />
              {col.name}
            </span>
          ))}
        <span className="flex items-center gap-1">
          <span
            className="inline-block h-2.5 w-4 rounded-sm"
            style={{ background: '#cbd5e1', opacity: 0.6 }}
          />
          SKIP
        </span>
        <span className="flex items-center gap-1">
          <svg width={16} height={8}>
            <line
              x1={0}
              y1={4}
              x2={16}
              y2={4}
              stroke="var(--border)"
              strokeWidth={1.5}
              strokeDasharray="4 3"
            />
          </svg>
          data
        </span>
        <span className="flex items-center gap-1">
          <svg width={16} height={8}>
            <line x1={0} y1={4} x2={16} y2={4} stroke="var(--border)" strokeWidth={2} />
          </svg>
          requires
        </span>
        <span className="flex items-center gap-1">
          <svg width={16} height={8}>
            <line x1={0} y1={4} x2={16} y2={4} stroke="var(--destructive)" strokeWidth={3} />
          </svg>
          blocks
        </span>
      </div>
    </div>
  );
}
