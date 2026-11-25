import { useState, useMemo, useCallback } from 'react';
import type { CompiledWorkflow } from '@/services/workflows';
import type { StageState } from '@/services/intents';
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
import { cn } from '@/lib/utils';

const STATUS_NODE_STYLE: Record<
  StageState,
  { fill: string; textFill: string; stroke?: string; strokeDash?: string; pulse?: boolean }
> = {
  SUCCEEDED: { fill: 'var(--agent-success)', textFill: '#ffffff' },
  FAILED: { fill: 'var(--agent-error)', textFill: '#ffffff' },
  RUNNING: { fill: 'var(--agent-running)', textFill: '#ffffff', pulse: true },
  WAITING_FOR_HUMAN: { fill: 'var(--agent-waiting)', textFill: '#1c1917' },
  PENDING: { fill: 'var(--muted)', textFill: 'var(--muted-foreground)' },
  SKIPPED: {
    fill: 'var(--muted)',
    textFill: 'var(--muted-foreground)',
    stroke: 'var(--muted-foreground)',
    strokeDash: '4 3',
  },
};

export interface WorkflowScopeGraphProps {
  compiled: CompiledWorkflow;
  scopes?: string[];
  phases?: PhaseInput[];
  defaultScope?: string;
  activeScope?: string | null;
  onActiveScopeChange?: (scope: string) => void;
  hideScopeSelector?: boolean;
  /** The host renders its own legend (e.g. a Sheet header). */
  hideLegend?: boolean;
  /** The host renders its own "n of m stages run" sentence. */
  hideSummary?: boolean;
  /**
   * Draw a stage's dependency edges only while it is hovered, focused or
   * selected, instead of every edge at once. Needs `onStageClick` so the
   * nodes are focusable. Default: every edge, always.
   */
  edgesOnFocus?: boolean;
  stageMeta?: Record<string, { number: string; name: string; phase: string }>;
  scopeDescriptions?: Record<string, string>;
  readOnly?: boolean;
  onToggleScope?: (stageId: string, scopeId: string, next: 'EXECUTE' | 'SKIP') => void;
  stageStatus?: Record<string, StageState>;
  onStageClick?: (stageId: string) => void;
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
  activeScope: activeScopeProp,
  onActiveScopeChange,
  hideScopeSelector,
  hideLegend,
  hideSummary,
  edgesOnFocus = false,
  stageMeta: stageMetaProp,
  scopeDescriptions: scopeDescProp,
  readOnly,
  onToggleScope,
  stageStatus,
  onStageClick,
}: WorkflowScopeGraphProps) {
  const graphNodeIds = useMemo(
    () => new Set(compiled.graph.nodes.map((n) => n.stageId)),
    [compiled],
  );

  const scopeList = useMemo(
    () => scopesProp ?? deriveScopeList(compiled.scopeGrid, graphNodeIds),
    [scopesProp, compiled.scopeGrid, graphNodeIds],
  );

  const [internalActiveScope, setInternalActiveScope] = useState(
    () => defaultScope ?? pickDefaultScope(scopeList, compiled.scopeGrid),
  );
  const activeScope = activeScopeProp ?? internalActiveScope;

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
  const hasBoltRounds = compiled.graph.nodes.some((n) => n.forEach === 'unit-of-work');

  // Dependency edges are drawn for one stage at a time — the hovered one, or
  // the one pinned by a click/tap — instead of the whole graph at once.
  const [hoverStage, setHoverStage] = useState<string | null>(null);
  const [pinnedStage, setPinnedStage] = useState<string | null>(null);
  const focusStage = edgesOnFocus ? (hoverStage ?? pinnedStage) : null;
  const focusEdges = useMemo(
    () =>
      !edgesOnFocus
        ? compiled.graph.edges
        : focusStage
          ? compiled.graph.edges.filter((e) => e.from === focusStage || e.to === focusStage)
          : [],
    [compiled.graph.edges, edgesOnFocus, focusStage],
  );

  // Edges under the nodes (all of them, as always), or above them for the
  // focused stage only.
  const edgeLayer = (() => {
    const pairSeen = new Map<string, number>();
    const pairTotal = new Map<string, number>();
    for (const edge of focusEdges) {
      const pk = `${edge.from}->${edge.to}`;
      pairTotal.set(pk, (pairTotal.get(pk) ?? 0) + 1);
    }
    return focusEdges.map((edge) => {
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
          data-edge={pk}
          d={cubicEdgePath(from, to, offset)}
          fill="none"
          stroke={live ? style.color : style.dimColor}
          strokeWidth={style.width}
          strokeDasharray={style.dash}
          opacity={live ? 0.85 : edgesOnFocus ? 0.5 : 0.18}
          className="pointer-events-none"
        />
      );
    });
  })();

  const handleNodeKeyDown = useCallback(
    (e: React.KeyboardEvent, stageId: string) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onStageClick?.(stageId);
      }
    },
    [onStageClick],
  );

  return (
    <div className="flex flex-col gap-3">
      {!hideScopeSelector && (
        <div className="flex flex-wrap gap-1.5">
          {scopeList.map((scope) => (
            <Button
              key={scope}
              variant={scope === activeScope ? 'secondary' : 'ghost'}
              size="sm"
              className="h-7 px-2.5 text-xs"
              onClick={() => {
                if (activeScopeProp !== undefined) {
                  onActiveScopeChange?.(scope);
                  return;
                }
                setInternalActiveScope(scope);
              }}
            >
              {scope}
            </Button>
          ))}
        </div>
      )}

      <div className="overflow-x-auto">
        <svg
          viewBox={`0 0 ${layout.width} ${layout.height}`}
          // Natural width as a floor: a narrow host scrolls instead of shrinking the labels.
          style={{ minWidth: layout.width }}
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

          {!edgesOnFocus && edgeLayer}

          {compiled.graph.nodes.map((node) => {
            const pos = layout.positions.get(node.stageId);
            if (!pos) return null;
            const inScope = executeSet.has(node.stageId);
            const statusEntry = stageStatus?.[node.stageId];
            const statusStyle = statusEntry ? STATUS_NODE_STYLE[statusEntry] : undefined;
            const fill = statusStyle
              ? statusStyle.fill
              : inScope
                ? (colorByPath[pos.phasePath] ?? '#94a3b8')
                : '#cbd5e1';
            const textFill = statusStyle ? statusStyle.textFill : inScope ? '#ffffff' : '#475569';
            const nodeOpacity = statusStyle
              ? statusEntry === 'SKIPPED'
                ? 0.55
                : 1
              : inScope
                ? 1
                : 0.6;
            const stageInfo = meta[node.stageId];
            const displayNum = stageInfo?.number ?? '';
            const displayName = truncateName(stageInfo?.name ?? node.stageId, 30);
            return (
              <g
                key={node.stageId}
                transform={`translate(${pos.x},${pos.y})`}
                opacity={nodeOpacity}
                className={cn(
                  statusStyle?.pulse && 'animate-pulse-subtle',
                  onStageClick &&
                    'focus-visible:[outline:2px_solid_var(--ring)] [outline-offset:2px]',
                )}
                data-stage-status={statusEntry ?? undefined}
                data-focused={focusStage === node.stageId || undefined}
                {...(edgesOnFocus
                  ? {
                      onMouseEnter: () => setHoverStage(node.stageId),
                      onMouseLeave: () =>
                        setHoverStage((cur) => (cur === node.stageId ? null : cur)),
                      onFocus: () => setHoverStage(node.stageId),
                      onBlur: () => setHoverStage((cur) => (cur === node.stageId ? null : cur)),
                    }
                  : {})}
                onClick={() => {
                  if (edgesOnFocus)
                    setPinnedStage((cur) => (cur === node.stageId ? null : node.stageId));
                  onStageClick?.(node.stageId);
                }}
                {...(onStageClick
                  ? {
                      role: 'button',
                      tabIndex: 0,
                      'aria-label': stageInfo?.name || node.stageId,
                      style: { cursor: 'pointer' },
                      onKeyDown: (e: React.KeyboardEvent) => handleNodeKeyDown(e, node.stageId),
                    }
                  : {})}
              >
                <rect
                  width={NODE_W}
                  height={NODE_H}
                  rx={6}
                  fill={fill}
                  stroke={
                    focusStage === node.stageId ? 'var(--ring)' : (statusStyle?.stroke ?? 'none')
                  }
                  strokeWidth={focusStage === node.stageId ? 2 : statusStyle?.stroke ? 1.5 : 0}
                  strokeDasharray={
                    focusStage === node.stageId ? undefined : (statusStyle?.strokeDash ?? undefined)
                  }
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
                {!stageStatus && (
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
                      className="text-[11px] font-semibold"
                    >
                      {inScope ? 'EXEC' : 'SKIP'}
                    </text>
                  </g>
                )}
                {node.forEach && (
                  <g
                    transform="translate(8, 6)"
                    role="img"
                    aria-label={
                      node.forEach === 'unit-of-work'
                        ? `Round${node.section ? ` ${node.section}` : ''} — runs once per unit of work`
                        : 'Unsupported repetition mode'
                    }
                  >
                    <title>
                      {node.forEach === 'unit-of-work'
                        ? `Round${node.section ? ` ${node.section}` : ''} — runs once per unit of work`
                        : 'Unsupported repetition mode'}
                    </title>
                    <rect
                      width={node.forEach === 'unit-of-work' ? 58 : 92}
                      height={16}
                      rx={8}
                      fill={node.forEach === 'unit-of-work' ? '#0f766e' : '#92400e'}
                      opacity={0.92}
                    />
                    <text
                      x={node.forEach === 'unit-of-work' ? 29 : 46}
                      y={12}
                      textAnchor="middle"
                      fill="#ffffff"
                      className="text-[11px] font-semibold"
                    >
                      {node.forEach === 'unit-of-work'
                        ? `Round${node.section ? ` ${node.section}` : ''}`
                        : 'UNSUPPORTED'}
                    </text>
                  </g>
                )}
              </g>
            );
          })}
          {edgesOnFocus && edgeLayer}
        </svg>
      </div>

      {edgesOnFocus && compiled.graph.edges.length > 0 && (
        <p className="text-2xs text-muted-foreground" data-testid="scope-graph-edge-hint">
          {focusStage
            ? `Showing the ${focusEdges.length === 1 ? 'dependency' : 'dependencies'} of ${meta[focusStage]?.name ?? focusStage}${pinnedStage === focusStage ? ' · select it again to clear' : ''}`
            : 'Hover or select a stage to see its dependencies.'}
        </p>
      )}

      {!hideSummary && (
        <p className="text-xs text-muted-foreground">
          <span className="font-semibold text-foreground">{activeScope}</span>
          {descriptions[activeScope] ? (
            <>
              {' · '}
              <em>{descriptions[activeScope]}</em>
            </>
          ) : null}
          {'. '}
          {executeSet.size} of {totalStages} stages run; {liveEdges} edges live within scope.
          {editable && ' · Toggle the EXEC/SKIP switch on a stage to include it in this scope.'}
        </p>
      )}

      {!hideLegend && (
        <ul
          aria-label="Legend"
          className="flex flex-wrap items-center gap-x-4 gap-y-1 text-2xs text-muted-foreground"
        >
          {layout.phaseColumns
            .filter((c) => c.phasePath !== '__other__')
            .map((col) => (
              <li key={col.phasePath} className="flex items-center gap-1">
                <span
                  aria-hidden="true"
                  className="inline-block h-2.5 w-4 rounded-sm"
                  style={{ background: colorByPath[col.phasePath] }}
                />
                {col.name}
              </li>
            ))}
          <li className="flex items-center gap-1">
            <span
              aria-hidden="true"
              className="inline-block h-2.5 w-4 rounded-sm"
              style={{ background: '#cbd5e1', opacity: 0.6 }}
            />
            Skipped in scope
          </li>
          {hasBoltRounds && (
            <li className="flex items-center gap-1">
              <span
                aria-hidden="true"
                className="inline-block rounded-full px-1.5 text-2xs font-semibold text-white"
                style={{ background: '#0f766e' }}
              >
                Round n
              </span>
              Round n — runs once per unit of work (one pass per unit, in parallel)
            </li>
          )}
          <li className="flex items-center gap-1">
            <svg width={16} height={8} aria-hidden="true">
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
            Data flow
          </li>
          <li className="flex items-center gap-1">
            <svg width={16} height={8} aria-hidden="true">
              <line x1={0} y1={4} x2={16} y2={4} stroke="var(--border)" strokeWidth={2} />
            </svg>
            Requires
          </li>
          <li className="flex items-center gap-1">
            <svg width={16} height={8} aria-hidden="true">
              <line x1={0} y1={4} x2={16} y2={4} stroke="var(--destructive)" strokeWidth={3} />
            </svg>
            Blocks
          </li>
        </ul>
      )}
    </div>
  );
}
