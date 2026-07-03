import { useEffect, useMemo, useState } from 'react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { useIntent } from '@/contexts/IntentContext';
import { useDiscussions } from '@/components/discussion/DiscussionProvider';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { artifactAccent } from '@/components/intent/artifactAccent';
import {
  intentsService,
  type IntentGraphEdge,
  type IntentGraphNode,
  type IntentKnowledgeGraph,
} from '@/services/intents';
import {
  BookOpen,
  Compass,
  FileText,
  HelpCircle,
  MessageSquare,
  MessagesSquare,
  ShieldCheck,
  Target,
} from 'lucide-react';

// The intent's KNOWLEDGE graph — the Neptune business subgraph the agents
// traverse: artifacts + their typed relations, questions, discussion threads,
// and the project knowledge/learnings injected into every stage. This is the
// v2 analog of v1's sprint graph, scoped to "what did this run produce and
// draw on". The STAGE pipeline (IntentGraph) stays separate — process vs
// knowledge.
//
// Layout: deterministic force settle (circle seed by stable node order, fixed
// iteration count, no randomness) — the same graph always renders identically.

const NODE_W = 150;
const NODE_H = 44;
const PAD = 16;

// Deterministic force settle. Pure + exported for tests: identical inputs
// yield identical positions (index-seeded circle start, fixed iterations).
export function settleLayout(
  nodes: { id: string }[],
  edges: { source: string; target: string }[],
  { iterations = 260, springLength = 200 }: { iterations?: number; springLength?: number } = {},
): Map<string, { x: number; y: number }> {
  const pts = nodes.map((n, i) => ({
    id: n.id,
    x: 340 * Math.cos((2 * Math.PI * i) / Math.max(nodes.length, 1)),
    y: 340 * Math.sin((2 * Math.PI * i) / Math.max(nodes.length, 1)),
    vx: 0,
    vy: 0,
  }));
  const byId = new Map(pts.map((p) => [p.id, p]));
  for (let iter = 0; iter < iterations; iter++) {
    // Pairwise repulsion.
    for (let i = 0; i < pts.length; i++) {
      for (let j = i + 1; j < pts.length; j++) {
        const a = pts[i];
        const b = pts[j];
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = 12000 / (dist * dist);
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        a.vx -= fx;
        a.vy -= fy;
        b.vx += fx;
        b.vy += fy;
      }
    }
    // Spring attraction along edges.
    for (const e of edges) {
      const s = byId.get(e.source);
      const t = byId.get(e.target);
      if (!s || !t) continue;
      const dx = t.x - s.x;
      const dy = t.y - s.y;
      const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
      const force = (dist - springLength) * 0.012;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      s.vx += fx;
      s.vy += fy;
      t.vx -= fx;
      t.vy -= fy;
    }
    // Center gravity + damping.
    for (const p of pts) {
      p.vx += (0 - p.x) * 0.002;
      p.vy += (0 - p.y) * 0.002;
      p.vx *= 0.85;
      p.vy *= 0.85;
      p.x += p.vx;
      p.y += p.vy;
    }
  }
  return new Map(pts.map((p) => [p.id, { x: p.x, y: p.y }]));
}

// Node-type registry (v2 vertex labels). Artifact accents are hashed per
// artifactType on top of this (see artifactAccent).
const NODE_TYPES: Record<
  string,
  { label: string; Icon: typeof FileText; chip: string; dot: string }
> = {
  Intent: {
    label: 'Intent',
    Icon: Target,
    chip: 'border-primary/60 bg-primary/[0.06]',
    dot: 'bg-primary',
  },
  Artifact: {
    label: 'Artifact',
    Icon: FileText,
    chip: 'bg-card',
    dot: 'bg-muted-foreground', // per-node accent overrides this
  },
  Question: {
    label: 'Question',
    Icon: HelpCircle,
    chip: 'border-agent-waiting/50 bg-agent-waiting/[0.07]',
    dot: 'bg-agent-waiting',
  },
  Steering: {
    label: 'Course correction',
    Icon: Compass,
    chip: 'border-amber-500/50 bg-amber-500/[0.07]',
    dot: 'bg-amber-500',
  },
  Discussion: {
    label: 'Discussion',
    Icon: MessagesSquare,
    chip: 'border-teal-500/50 bg-teal-500/[0.07]',
    dot: 'bg-teal-500',
  },
  TeamKnowledge: {
    label: 'Team knowledge',
    Icon: BookOpen,
    chip: 'border-blue-500/50 bg-blue-500/[0.07]',
    dot: 'bg-blue-500',
  },
  LearningRule: {
    label: 'Learning rule',
    Icon: ShieldCheck,
    chip: 'border-violet-500/50 bg-violet-500/[0.07]',
    dot: 'bg-violet-500',
  },
};
const typeCfg = (type: string) => NODE_TYPES[type] ?? NODE_TYPES.Artifact;

export function KnowledgeGraph() {
  const { projectId, intentId, detail, gates } = useIntent();
  const discussions = useDiscussions();
  const [graph, setGraph] = useState<IntentKnowledgeGraph | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // Fetch on mount; refetch whenever the detail DTO reloads (which happens in
  // realtime on artifact/question/stage events), keeping the previous graph on
  // screen during the refresh so the canvas never flashes empty.
  useEffect(() => {
    if (!projectId || !intentId) return;
    let cancelled = false;
    intentsService
      .graph(projectId, intentId)
      .then((next) => {
        if (cancelled) return;
        setGraph(next);
        setError(null);
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to load knowledge graph');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, intentId, detail]);

  // Stable order (type, then id) so the layout seed — and therefore the whole
  // settled layout — is identical run to run.
  const nodes = useMemo(
    () =>
      (graph?.nodes ?? []).toSorted(
        (a, b) => a.type.localeCompare(b.type) || a.id.localeCompare(b.id),
      ),
    [graph],
  );
  const edges = useMemo(() => graph?.edges ?? [], [graph]);

  const { positions, width, height } = useMemo(() => {
    const raw = settleLayout(nodes, edges);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const p of raw.values()) {
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX)) {
      return { positions: new Map<string, { x: number; y: number }>(), width: 0, height: 0 };
    }
    // Normalize to positive space; positions are node CENTERS.
    const centered = new Map<string, { x: number; y: number }>();
    for (const [id, p] of raw) {
      centered.set(id, { x: p.x - minX + PAD + NODE_W / 2, y: p.y - minY + PAD + NODE_H / 2 });
    }
    return {
      positions: centered,
      width: maxX - minX + NODE_W + PAD * 2,
      height: maxY - minY + NODE_H + PAD * 2,
    };
  }, [nodes, edges]);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const n of nodes) c.set(n.type, (c.get(n.type) ?? 0) + 1);
    return c;
  }, [nodes]);

  const selected = selectedId ? (nodes.find((n) => n.id === selectedId) ?? null) : null;

  if (loading && !graph) {
    return <Skeleton className="h-48 rounded-md" />;
  }
  if (error && !graph) {
    return <p className="text-sm text-destructive">{error}</p>;
  }
  if (nodes.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Nothing recorded yet — artifacts, questions and knowledge appear here as the agents work.
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {/* Legend */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        {[...counts.entries()].map(([type, count]) => {
          const cfg = typeCfg(type);
          return (
            <span
              key={type}
              className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground"
            >
              <span className={cn('h-2 w-2 rounded-full', cfg.dot)} />
              {cfg.label}
              <span className="tabular-nums">{count}</span>
            </span>
          );
        })}
      </div>

      {/* Canvas */}
      <div className="max-h-[480px] overflow-auto rounded-md border bg-muted/10">
        <div className="relative" style={{ width, height }}>
          <svg
            width={width}
            height={height}
            className="absolute inset-0 text-muted-foreground"
            aria-hidden
          >
            <defs>
              <marker
                id="knowledge-graph-arrow"
                viewBox="0 0 8 8"
                refX="7"
                refY="4"
                markerWidth="5"
                markerHeight="5"
                orient="auto-start-reverse"
              >
                <path d="M 0 0 L 8 4 L 0 8 z" fill="currentColor" />
              </marker>
            </defs>
            {edges.map((e, i) => (
              <KnowledgeEdge
                key={`${e.source}-${e.target}-${e.label}-${i}`}
                edge={e}
                positions={positions}
                selectedId={selectedId}
              />
            ))}
          </svg>

          {nodes.map((n) => {
            const pos = positions.get(n.id);
            if (!pos) return null;
            const cfg = typeCfg(n.type);
            const accent =
              n.type === 'Artifact' ? artifactAccent(n.artifactType as string | null) : null;
            const isSelected = n.id === selectedId;
            // Rewind lineage: superseded artifacts came from a rewound stage
            // attempt and are dimmed until the re-run rehabilitates them.
            const isSuperseded = n.type === 'Artifact' && Boolean(n.superseded);
            return (
              <button
                key={n.id}
                type="button"
                title={n.label}
                onClick={() => setSelectedId(isSelected ? null : n.id)}
                style={{
                  left: pos.x - NODE_W / 2,
                  top: pos.y - NODE_H / 2,
                  width: NODE_W,
                  height: NODE_H,
                }}
                className={cn(
                  'absolute flex items-center gap-2 rounded-md border px-2 py-1 text-left shadow-sm transition-colors hover:bg-muted/40',
                  cfg.chip,
                  accent?.border,
                  isSuperseded && 'opacity-50',
                  isSelected && 'ring-2 ring-primary',
                )}
              >
                <span className={cn('h-2 w-2 shrink-0 rounded-full', accent?.dot ?? cfg.dot)} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[11px] font-medium leading-tight">
                    {n.label}
                  </span>
                  <span className="block truncate text-[9px] text-muted-foreground">
                    {n.type === 'Artifact' ? ((n.artifactType as string) ?? 'artifact') : cfg.label}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </div>

      {/* Type-aware detail for the selected node */}
      {selected && (
        <NodeDetail
          node={selected}
          onOpenDiscussion={(id) => discussions?.openDiscussionById(id)}
          answeredGate={
            selected.type === 'Question'
              ? (gates.find((g) => g.humanTaskId === selected.id) ?? null)
              : null
          }
          producedByStageId={
            selected.type === 'Artifact'
              ? (detail?.stages.find((s) => s.stageInstanceId === selected.createdByStageInstanceId)
                  ?.stageId ?? null)
              : null
          }
        />
      )}
    </div>
  );
}

// Edge styling by relation kind: business edges solid + labeled; CONTAINS is
// faint structure; INFORMS (project knowledge → run) dotted; DISCUSSES dashed.
function KnowledgeEdge({
  edge,
  positions,
  selectedId,
}: {
  edge: IntentGraphEdge;
  positions: Map<string, { x: number; y: number }>;
  selectedId: string | null;
}) {
  const from = positions.get(edge.source);
  const to = positions.get(edge.target);
  if (!from || !to) return null;
  const touches = edge.source === selectedId || edge.target === selectedId;
  const structural = edge.label === 'CONTAINS';
  const informs = edge.label === 'INFORMS';
  const dash = structural ? '3 4' : informs ? '1.5 3.5' : edge.label === 'DISCUSSES' ? '5 3' : '';
  const labeled = !structural && !informs;
  const midX = (from.x + to.x) / 2;
  const midY = (from.y + to.y) / 2;
  return (
    <g
      className={cn(touches && 'text-primary')}
      opacity={touches ? 0.9 : structural || informs ? 0.25 : 0.5}
    >
      <line
        x1={from.x}
        y1={from.y}
        x2={to.x}
        y2={to.y}
        stroke="currentColor"
        strokeWidth={touches ? 1.8 : 1.2}
        strokeDasharray={dash || undefined}
        markerEnd={structural ? undefined : 'url(#knowledge-graph-arrow)'}
      />
      {labeled && (
        <text x={midX} y={midY - 4} textAnchor="middle" fontSize="8" fill="currentColor">
          {edge.label.toLowerCase().replace(/_/g, ' ')}
        </text>
      )}
    </g>
  );
}

function NodeDetail({
  node,
  onOpenDiscussion,
  answeredGate,
  producedByStageId,
}: {
  node: IntentGraphNode;
  onOpenDiscussion: (discussionId: string) => void;
  answeredGate: { status: string } | null;
  producedByStageId: string | null;
}) {
  const cfg = typeCfg(node.type);
  const preview = (node.contentPreview as string) ?? '';
  const questionTexts = useMemo(() => {
    if (node.type !== 'Question') return [];
    try {
      const parsed = JSON.parse((node.questions as string) ?? '[]');
      return Array.isArray(parsed)
        ? parsed.map((q: { text?: string }) => String(q.text ?? ''))
        : [];
    } catch {
      return [];
    }
  }, [node]);
  const questionAnswered =
    node.type === 'Question' &&
    ((answeredGate && answeredGate.status !== 'pending') || Boolean(node.answeredAt));

  return (
    <div className="space-y-2 rounded-md border bg-muted/20 px-3 py-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <cfg.Icon className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="font-medium">{node.label}</span>
        <Badge variant="secondary" className="px-1 py-0 text-[9px]">
          {node.type === 'Artifact' ? ((node.artifactType as string) ?? 'artifact') : cfg.label}
        </Badge>
        {node.type === 'Question' && (
          <Badge
            variant="outline"
            className={cn(
              'px-1 py-0 text-[9px]',
              questionAnswered
                ? 'bg-agent-success/15 text-agent-success border-agent-success/30'
                : 'bg-agent-waiting/15 text-agent-waiting border-agent-waiting/30',
            )}
          >
            {questionAnswered ? 'answered' : 'pending'}
          </Badge>
        )}
        {node.type === 'Artifact' && Boolean(node.superseded) && (
          <Badge variant="outline" className="bg-muted px-1 py-0 text-[9px] text-muted-foreground">
            superseded
          </Badge>
        )}
        {node.type === 'Steering' && !!node.kind && (
          <Badge variant="outline" className="px-1 py-0 text-[9px]">
            {String(node.kind)}
          </Badge>
        )}
        {node.type === 'Discussion' && !!node.status && (
          <Badge variant="outline" className="px-1 py-0 text-[9px]">
            {String(node.status)}
          </Badge>
        )}
        {node.type === 'TeamKnowledge' && !!node.agentRef && (
          <Badge variant="outline" className="px-1 py-0 text-[9px]">
            {String(node.agentRef)}
          </Badge>
        )}
        {node.type === 'LearningRule' && !!node.layer && (
          <Badge variant="outline" className="px-1 py-0 text-[9px]">
            {String(node.layer)}
          </Badge>
        )}
      </div>

      {/* Provenance line */}
      <p className="text-[11px] text-muted-foreground">
        {node.type === 'Artifact' && producedByStageId && <>produced by {producedByStageId} · </>}
        {(node.type === 'TeamKnowledge' || node.type === 'LearningRule') &&
          !!node.createdByIntentId && <>from intent {String(node.createdByIntentId)} · </>}
        {!!node.createdAt && new Date(String(node.createdAt)).toLocaleString()}
      </p>

      {questionTexts.length > 0 && (
        <ul className="list-disc space-y-0.5 pl-5 text-[12px]">
          {questionTexts.map((t, i) => (
            <li key={i}>{t}</li>
          ))}
        </ul>
      )}

      {preview && (
        <p className="line-clamp-4 whitespace-pre-wrap text-[12px] text-muted-foreground">
          {preview}
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2">
        {node.type === 'Artifact' && (
          <>
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() =>
                document
                  .getElementById(`artifact-${node.id}`)
                  ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
              }
            >
              <FileText className="h-3 w-3" />
              Open artifact card
            </Button>
            <DiscussButton entityType="artifact" entityId={node.id} entityTitle={node.label} />
          </>
        )}
        {node.type === 'Question' && (
          <DiscussButton
            entityType="question"
            entityId={node.id}
            entityTitle={questionTexts[0] || node.label}
          />
        )}
        {node.type === 'Discussion' && (
          <Button
            size="sm"
            variant="outline"
            className="h-6 gap-1 px-2 text-[11px]"
            onClick={() => onOpenDiscussion(node.id)}
          >
            <MessageSquare className="h-3 w-3" />
            Open thread
          </Button>
        )}
      </div>
    </div>
  );
}
