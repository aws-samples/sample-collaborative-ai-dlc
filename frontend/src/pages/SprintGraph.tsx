import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { sprintGraphService, type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { useSprint } from '@/contexts/SprintContext';
import { cn } from '@/lib/utils';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Separator } from '@/components/ui/separator';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  Search,
  Maximize2,
  X,
  Filter,
  FileText,
  BookOpen,
  ListChecks,
  Code2,
  HelpCircle,
  ShieldCheck,
  Info,
  GitPullRequest,
  Loader2,
  Network,
  LayoutGrid,
  Share2,
  Orbit,
  ChevronRight,
  Minus,
  Plus,
  Eye,
  EyeOff,
  Sparkles,
  ArrowRight,
  ArrowLeft,
  Map as MapIcon,
  BarChart3,
  Keyboard,
  Bot,
  MessageSquare,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const NODE_TYPES: Record<
  string,
  {
    color: string;
    darkColor: string;
    gradientFrom: string;
    gradientTo: string;
    textColor: string;
    icon: React.ComponentType<{ className?: string }>;
    label: string;
    shortLabel: string;
  }
> = {
  Requirement: {
    color: '#f97316',
    darkColor: '#ea580c',
    gradientFrom: '#fb923c',
    gradientTo: '#ea580c',
    textColor: '#fff',
    icon: FileText,
    label: 'Requirement',
    shortLabel: 'Req',
  },
  UserStory: {
    color: '#22c55e',
    darkColor: '#16a34a',
    gradientFrom: '#4ade80',
    gradientTo: '#16a34a',
    textColor: '#fff',
    icon: BookOpen,
    label: 'User Story',
    shortLabel: 'Story',
  },
  Task: {
    color: '#eab308',
    darkColor: '#ca8a04',
    gradientFrom: '#facc15',
    gradientTo: '#ca8a04',
    textColor: '#000',
    icon: ListChecks,
    label: 'Task',
    shortLabel: 'Task',
  },
  CodeFile: {
    color: '#ef4444',
    darkColor: '#dc2626',
    gradientFrom: '#f87171',
    gradientTo: '#dc2626',
    textColor: '#fff',
    icon: Code2,
    label: 'Code File',
    shortLabel: 'Code',
  },
  Review: {
    color: '#a855f7',
    darkColor: '#9333ea',
    gradientFrom: '#c084fc',
    gradientTo: '#9333ea',
    textColor: '#fff',
    icon: ShieldCheck,
    label: 'Review',
    shortLabel: 'Rev',
  },
  Question: {
    color: '#0ea5e9',
    darkColor: '#0284c7',
    gradientFrom: '#38bdf8',
    gradientTo: '#0284c7',
    textColor: '#fff',
    icon: HelpCircle,
    label: 'Question',
    shortLabel: 'Q',
  },
  GeneralInfo: {
    color: '#3b82f6',
    darkColor: '#2563eb',
    gradientFrom: '#60a5fa',
    gradientTo: '#2563eb',
    textColor: '#fff',
    icon: Info,
    label: 'General Info',
    shortLabel: 'Info',
  },
  PullRequest: {
    color: '#6366f1',
    darkColor: '#4f46e5',
    gradientFrom: '#818cf8',
    gradientTo: '#4f46e5',
    textColor: '#fff',
    icon: GitPullRequest,
    label: 'Pull Request',
    shortLabel: 'PR',
  },
  AgentRun: {
    color: '#64748b',
    darkColor: '#475569',
    gradientFrom: '#94a3b8',
    gradientTo: '#475569',
    textColor: '#fff',
    icon: Bot,
    label: 'Agent Run',
    shortLabel: 'Run',
  },
  Discussion: {
    color: '#14b8a6',
    darkColor: '#0d9488',
    gradientFrom: '#2dd4bf',
    gradientTo: '#0d9488',
    textColor: '#fff',
    icon: MessageSquare,
    label: 'Discussion',
    shortLabel: 'Disc',
  },
};

const EDGE_LABELS: Record<string, string> = {
  BREAKS_INTO: 'breaks into',
  IMPLEMENTED_BY: 'implemented by',
  DEPENDS_ON: 'depends on',
  REVIEWS: 'reviews',
  VALIDATES: 'validates',
  INFLUENCES: 'influences',
  RELATES_TO: 'relates to',
  CARRIED_FROM: 'carried from',
  DISCUSSES: 'discusses',
};

const NODE_W = 156;
const NODE_H = 52;
const NODE_RX = 12;
const ICON_SIZE = 14;

// Hierarchical type ordering (top to bottom)
const TYPE_HIERARCHY: string[] = [
  'AgentRun',
  'Requirement',
  'GeneralInfo',
  'UserStory',
  'Task',
  'CodeFile',
  'Review',
  'Question',
  'PullRequest',
  'Discussion',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
}

interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

type LayoutMode = 'force' | 'hierarchical';

// ---------------------------------------------------------------------------
// Utility: Convex hull (Andrew's monotone chain)
// ---------------------------------------------------------------------------

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const pts = [...points].sort((a, b) => a.x - b.x || a.y - b.y);
  const cross = (
    O: { x: number; y: number },
    A: { x: number; y: number },
    B: { x: number; y: number },
  ) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);

  const lower: { x: number; y: number }[] = [];
  for (const p of pts) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
      lower.pop();
    lower.push(p);
  }
  const upper: { x: number; y: number }[] = [];
  for (let i = pts.length - 1; i >= 0; i--) {
    const p = pts[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
      upper.pop();
    upper.push(p);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function hullPath(nodes: LayoutNode[], padding: number): string {
  if (nodes.length === 0) return '';
  if (nodes.length === 1) {
    const n = nodes[0];
    return `M ${n.x - padding} ${n.y} a ${padding} ${padding} 0 1 0 ${padding * 2} 0 a ${padding} ${padding} 0 1 0 ${-padding * 2} 0`;
  }
  if (nodes.length === 2) {
    const [a, b] = nodes;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = (-dy / len) * padding;
    const ny = (dx / len) * padding;
    return `M ${a.x + nx} ${a.y + ny} L ${b.x + nx} ${b.y + ny} A ${padding} ${padding} 0 0 1 ${b.x - nx} ${b.y - ny} L ${a.x - nx} ${a.y - ny} A ${padding} ${padding} 0 0 1 ${a.x + nx} ${a.y + ny} Z`;
  }

  const hull = convexHull(nodes.map((n) => ({ x: n.x, y: n.y })));
  // Expand hull by padding and create rounded path
  const expanded = hull.map((p) => {
    const cx = hull.reduce((s, h) => s + h.x, 0) / hull.length;
    const cy = hull.reduce((s, h) => s + h.y, 0) / hull.length;
    const dx = p.x - cx;
    const dy = p.y - cy;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    return { x: p.x + (dx / len) * padding, y: p.y + (dy / len) * padding };
  });

  if (expanded.length === 0) return '';
  return (
    `M ${expanded[0].x} ${expanded[0].y} ` +
    expanded
      .slice(1)
      .map((p) => `L ${p.x} ${p.y}`)
      .join(' ') +
    ' Z'
  );
}

// ---------------------------------------------------------------------------
// Derive a human-readable label for nodes that come through as "(unnamed)"
// ---------------------------------------------------------------------------

function deriveNodeLabel(node: GraphNode): string {
  // If the backend already gave a good label, keep it
  if (node.label && node.label !== '(unnamed)') return node.label;

  switch (node.type) {
    case 'Question': {
      // Extract first question text from the JSON questions array
      const raw = node.questions;
      if (typeof raw === 'string' && raw) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed) && parsed.length > 0) {
            const first = parsed[0]?.text || parsed[0]?.question || '';
            if (first) {
              const truncated = first.length > 50 ? first.slice(0, 48) + '...' : first;
              return parsed.length > 1 ? `${truncated} (+${parsed.length - 1})` : truncated;
            }
          }
        } catch {
          /* fall through */
        }
      }
      return 'Question';
    }
    case 'Review': {
      const status = node.status;
      if (typeof status === 'string' && status) return `Review (${status})`;
      return 'Review';
    }
    case 'PullRequest': {
      const num = node.pr_number;
      if (num) return `PR #${num}`;
      return 'Pull Request';
    }
    case 'GeneralInfo': {
      const title = node.title;
      if (typeof title === 'string' && title) return title;
      const content = node.content;
      if (typeof content === 'string' && content) {
        return content.length > 50 ? content.slice(0, 48) + '...' : content;
      }
      return 'General Info';
    }
    default:
      return node.label || node.type;
  }
}

// ---------------------------------------------------------------------------
// Page Component
// ---------------------------------------------------------------------------

export default function SprintGraph() {
  const { sprintId, projectId } = useParams<{ projectId: string; sprintId: string }>();
  const { sprint } = useSprint();
  const navigate = useNavigate();

  // Data
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
  const [loading, setLoading] = useState(true);
  const [settled, setSettled] = useState(false);

  // Layout
  const [layoutMode, setLayoutMode] = useState<LayoutMode>('force');
  const [showClusters, setShowClusters] = useState(false);
  const [showMinimap, setShowMinimap] = useState(true);
  const [showStats, setShowStats] = useState(false);

  // Interaction
  const [selectedNode, setSelectedNode] = useState<string | null>(null);
  const [viewBox, setViewBox] = useState<ViewBox>({ x: -800, y: -450, width: 1600, height: 900 });
  const [isPanning, setIsPanning] = useState(false);
  const [panStart, setPanStart] = useState({ x: 0, y: 0, vbX: 0, vbY: 0 });
  const [dragNode, setDragNode] = useState<string | null>(null);
  const [dragStart, setDragStart] = useState({ x: 0, y: 0 });
  const [dragOriginX, setDragOriginX] = useState(0);
  const [dragOriginY, setDragOriginY] = useState(0);
  const dragNeighborIds = useRef<Set<string>>(new Set());
  const dragAnimRef = useRef<number>(0);
  const [hoveredNode, setHoveredNode] = useState<string | null>(null);

  // Filters
  const [search, setSearch] = useState('');
  const [typeFilters, setTypeFilters] = useState<Set<string>>(new Set());
  const [showFilters, setShowFilters] = useState(false);
  const [showKeyboardHelp, setShowKeyboardHelp] = useState(false);

  // Animation
  const [animationTime, setAnimationTime] = useState(0);

  const svgRef = useRef<SVGSVGElement>(null);
  const animRef = useRef<number>(0);
  const particleAnimRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---- Load data & pre-settle layout ----
  useEffect(() => {
    if (!sprintId) return;
    setLoading(true);
    setSettled(false);
    sprintGraphService
      .get(sprintId)
      .then(({ nodes: n, edges: e }) => {
        // Build initial positions in a circle
        const layoutNodes: LayoutNode[] = n.map((node, i) => ({
          ...node,
          label: deriveNodeLabel(node),
          x: 400 * Math.cos((2 * Math.PI * i) / Math.max(n.length, 1)),
          y: 400 * Math.sin((2 * Math.PI * i) / Math.max(n.length, 1)),
          vx: 0,
          vy: 0,
        }));

        // Run force simulation synchronously to settle the layout before rendering
        if (layoutNodes.length > 0) {
          const nodeMap = new Map<string, LayoutNode>();
          layoutNodes.forEach((nd) => nodeMap.set(nd.id, nd));

          for (let iter = 0; iter < 300; iter++) {
            // Repulsion
            for (let i = 0; i < layoutNodes.length; i++) {
              for (let j = i + 1; j < layoutNodes.length; j++) {
                const a = layoutNodes[i],
                  b = layoutNodes[j];
                const dx = b.x - a.x;
                const dy = b.y - a.y;
                const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
                const force = 10000 / (dist * dist);
                const fx = (dx / dist) * force;
                const fy = (dy / dist) * force;
                a.vx -= fx;
                a.vy -= fy;
                b.vx += fx;
                b.vy += fy;
              }
            }
            // Spring attraction along edges
            for (const edge of e) {
              const s = nodeMap.get(edge.source);
              const t = nodeMap.get(edge.target);
              if (!s || !t) continue;
              const dx = t.x - s.x;
              const dy = t.y - s.y;
              const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
              const force = (dist - 220) * 0.01;
              const fx = (dx / dist) * force;
              const fy = (dy / dist) * force;
              s.vx += fx;
              s.vy += fy;
              t.vx -= fx;
              t.vy -= fy;
            }
            // Center gravity + damping
            for (const nd of layoutNodes) {
              nd.vx += (0 - nd.x) * 0.001;
              nd.vy += (0 - nd.y) * 0.001;
              nd.vx *= 0.87;
              nd.vy *= 0.87;
              nd.x += nd.vx;
              nd.y += nd.vy;
            }
          }
          // Zero out velocities so the graph is static on first paint
          layoutNodes.forEach((nd) => {
            nd.vx = 0;
            nd.vy = 0;
          });
        }

        setNodes(layoutNodes);
        setEdges(e);
        // Reveal after a microtask so the first paint is the settled layout
        requestAnimationFrame(() => setSettled(true));
      })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [sprintId]);

  // ---- Initial viewBox from container ----
  useEffect(() => {
    if (!containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    if (width > 0 && height > 0) {
      setViewBox({ x: -width / 2, y: -height / 2, width, height });
    }
  }, [loading]);

  // ---- Fit-to-content once settled ----
  useEffect(() => {
    if (!settled || nodes.length === 0) return;
    const pad = 120;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - NODE_W / 2 - pad;
    const maxX = Math.max(...xs) + NODE_W / 2 + pad;
    const minY = Math.min(...ys) - NODE_H / 2 - pad;
    const maxY = Math.max(...ys) + NODE_H / 2 + pad;
    setViewBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
    // Only run once on initial settle
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled]);

  // ---- Force simulation ----
  const simulate = useCallback(() => {
    setNodes((prev) => {
      const next = prev.map((n) => ({ ...n }));
      const nodeMap = new Map(next.map((n) => [n.id, n]));

      // Repulsion
      for (let i = 0; i < next.length; i++) {
        for (let j = i + 1; j < next.length; j++) {
          const a = next[i],
            b = next[j];
          const dx = b.x - a.x;
          const dy = b.y - a.y;
          const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
          const force = 10000 / (dist * dist);
          const fx = (dx / dist) * force;
          const fy = (dy / dist) * force;
          if (!a.pinned) {
            a.vx -= fx;
            a.vy -= fy;
          }
          if (!b.pinned) {
            b.vx += fx;
            b.vy += fy;
          }
        }
      }

      // Spring attraction along edges
      for (const edge of edges) {
        const s = nodeMap.get(edge.source);
        const t = nodeMap.get(edge.target);
        if (!s || !t) continue;
        const dx = t.x - s.x;
        const dy = t.y - s.y;
        const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
        const force = (dist - 220) * 0.01;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        if (!s.pinned) {
          s.vx += fx;
          s.vy += fy;
        }
        if (!t.pinned) {
          t.vx -= fx;
          t.vy -= fy;
        }
      }

      // Center gravity + damping
      for (const n of next) {
        if (n.pinned) continue;
        n.vx += (0 - n.x) * 0.001;
        n.vy += (0 - n.y) * 0.001;
        n.vx *= 0.87;
        n.vy *= 0.87;
        n.x += n.vx;
        n.y += n.vy;
      }

      return next;
    });
  }, [edges]);

  // ---- Hierarchical layout ----
  const applyHierarchicalLayout = useCallback(() => {
    setNodes((prev) => {
      const groups: Record<string, LayoutNode[]> = {};
      prev.forEach((n) => {
        if (!groups[n.type]) groups[n.type] = [];
        groups[n.type].push(n);
      });

      const next = prev.map((n) => ({ ...n }));
      const nodeMap = new Map(next.map((n) => [n.id, n]));

      const typeOrder = TYPE_HIERARCHY.filter((t) => groups[t]);
      const rowGap = 180;
      const colGap = 200;

      typeOrder.forEach((type, rowIndex) => {
        const nodesOfType = next.filter((n) => n.type === type);
        const totalWidth = (nodesOfType.length - 1) * colGap;
        nodesOfType.forEach((n, colIndex) => {
          const node = nodeMap.get(n.id);
          if (!node) return;
          node.x = -totalWidth / 2 + colIndex * colGap;
          node.y = -((typeOrder.length - 1) * rowGap) / 2 + rowIndex * rowGap;
          node.vx = 0;
          node.vy = 0;
        });
      });

      return next;
    });
  }, []);

  useEffect(() => {
    if (nodes.length === 0 || !settled) return;

    if (layoutMode === 'hierarchical') {
      applyHierarchicalLayout();
      return;
    }

    // Force mode: only run a brief re-settle (e.g. after switching from hierarchical)
    // The initial load already settled synchronously, so this only fires on mode switch
    let frame = 0;
    const tick = () => {
      if (frame < 120) {
        simulate();
        frame++;
        animRef.current = requestAnimationFrame(tick);
      }
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, simulate, layoutMode, applyHierarchicalLayout]);

  // ---- Particle animation loop ----
  useEffect(() => {
    if (nodes.length === 0 || !settled) return;
    let time = 0;
    const tick = () => {
      time += 0.008;
      setAnimationTime(time);
      particleAnimRef.current = requestAnimationFrame(tick);
    };
    particleAnimRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(particleAnimRef.current);
  }, [nodes.length, settled]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      // Don't capture when input is focused
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;

      switch (e.key) {
        case 'f':
        case '/':
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case 'Escape':
          setSelectedNode(null);
          setSearch('');
          searchRef.current?.blur();
          setShowKeyboardHelp(false);
          break;
        case '1':
          setLayoutMode('force');
          break;
        case '2':
          setLayoutMode('hierarchical');
          break;
        case 'c':
          setShowClusters((prev) => !prev);
          break;
        case 'm':
          setShowMinimap((prev) => !prev);
          break;
        case 's':
          setShowStats((prev) => !prev);
          break;
        case '=':
        case '+':
          zoomIn();
          break;
        case '-':
          zoomOut();
          break;
        case '0':
          resetView();
          break;
        case '?':
          setShowKeyboardHelp((prev) => !prev);
          break;
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- Filtered data ----
  const filteredNodeIds = useMemo(() => {
    const ids = new Set<string>();
    nodes.forEach((n) => {
      const matchesType = typeFilters.size === 0 || typeFilters.has(n.type);
      const matchesSearch =
        !search ||
        n.label.toLowerCase().includes(search.toLowerCase()) ||
        n.type.toLowerCase().includes(search.toLowerCase());
      if (matchesType && matchesSearch) ids.add(n.id);
    });
    return ids;
  }, [nodes, typeFilters, search]);

  const filteredEdges = useMemo(
    () => edges.filter((e) => filteredNodeIds.has(e.source) && filteredNodeIds.has(e.target)),
    [edges, filteredNodeIds],
  );

  // ---- Adjacency index for drag grouping ----
  const adjacency = useMemo(() => {
    const map = new Map<string, Set<string>>();
    edges.forEach((e) => {
      if (!map.has(e.source)) map.set(e.source, new Set());
      if (!map.has(e.target)) map.set(e.target, new Set());
      map.get(e.source)!.add(e.target);
      map.get(e.target)!.add(e.source);
    });
    return map;
  }, [edges]);

  // ---- SVG coordinate helpers ----
  const svgToWorld = (clientX: number, clientY: number) => {
    if (!svgRef.current) return { x: 0, y: 0 };
    const rect = svgRef.current.getBoundingClientRect();
    return {
      x: viewBox.x + ((clientX - rect.left) / rect.width) * viewBox.width,
      y: viewBox.y + ((clientY - rect.top) / rect.height) * viewBox.height,
    };
  };

  // ---- Interaction handlers ----
  const handleWheel = (e: React.WheelEvent) => {
    e.preventDefault();
    const factor = e.deltaY > 0 ? 1.08 : 0.92;
    const mouse = svgToWorld(e.clientX, e.clientY);
    const newW = Math.max(300, Math.min(viewBox.width * factor, 12000));
    const newH = Math.max(300, Math.min(viewBox.height * factor, 12000));
    setViewBox({
      x: mouse.x - ((mouse.x - viewBox.x) / viewBox.width) * newW,
      y: mouse.y - ((mouse.y - viewBox.y) / viewBox.height) * newH,
      width: newW,
      height: newH,
    });
  };

  const handleMouseDown = (e: React.MouseEvent, nodeId?: string) => {
    if (nodeId) {
      const node = nodes.find((n) => n.id === nodeId);
      if (!node) return;
      const world = svgToWorld(e.clientX, e.clientY);
      setDragNode(nodeId);
      setDragStart({ x: world.x, y: world.y });
      setDragOriginX(node.x);
      setDragOriginY(node.y);

      // Collect neighbor IDs (not the dragged node itself)
      const neighbors = new Set<string>();
      const adj = adjacency.get(nodeId);
      if (adj) adj.forEach((id) => neighbors.add(id));
      dragNeighborIds.current = neighbors;

      // Only pin the dragged node -- neighbors stay free to be pulled
      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, pinned: true } : n)));

      // Start a spring-pull animation loop for neighbors
      const pullTick = () => {
        setNodes((prev) => {
          const draggedNode = prev.find((n) => n.id === nodeId);
          if (!draggedNode) return prev;

          // Collect neighbor nodes for inter-neighbor repulsion
          const neighborNodes = prev.filter((n) => neighbors.has(n.id));

          // Pre-compute repulsion forces between all neighbor pairs
          const repForces = new Map<string, { fx: number; fy: number }>();
          neighborNodes.forEach((n) => repForces.set(n.id, { fx: 0, fy: 0 }));
          for (let i = 0; i < neighborNodes.length; i++) {
            for (let j = i + 1; j < neighborNodes.length; j++) {
              const a = neighborNodes[i],
                b = neighborNodes[j];
              const rdx = b.x - a.x;
              const rdy = b.y - a.y;
              const rDist = Math.max(Math.sqrt(rdx * rdx + rdy * rdy), 1);
              const minSep = NODE_W + 20;
              if (rDist < minSep) {
                const repel = (minSep - rDist) * 0.15;
                const rux = rdx / rDist;
                const ruy = rdy / rDist;
                const fa = repForces.get(a.id)!;
                const fb = repForces.get(b.id)!;
                fa.fx -= rux * repel;
                fa.fy -= ruy * repel;
                fb.fx += rux * repel;
                fb.fy += ruy * repel;
              }
            }
          }

          return prev.map((n) => {
            if (!neighbors.has(n.id)) return n;

            // Spring pull toward dragged node
            const dx = draggedNode.x - n.x;
            const dy = draggedNode.y - n.y;
            const dist = Math.sqrt(dx * dx + dy * dy);
            let mx = 0,
              my = 0;
            const restDist = 160;
            if (dist > restDist) {
              const pull = (dist - restDist) * 0.08;
              mx = (dx / dist) * pull;
              my = (dy / dist) * pull;
            }

            // Add repulsion from other neighbors
            const rep = repForces.get(n.id);
            if (rep) {
              mx += rep.fx;
              my += rep.fy;
            }

            return { ...n, x: n.x + mx, y: n.y + my, vx: 0, vy: 0 };
          });
        });
        dragAnimRef.current = requestAnimationFrame(pullTick);
      };
      dragAnimRef.current = requestAnimationFrame(pullTick);
    } else {
      setIsPanning(true);
      setPanStart({ x: e.clientX, y: e.clientY, vbX: viewBox.x, vbY: viewBox.y });
    }
  };

  const handleMouseMove = (e: React.MouseEvent) => {
    if (dragNode) {
      const world = svgToWorld(e.clientX, e.clientY);
      const dx = world.x - dragStart.x;
      const dy = world.y - dragStart.y;
      // Only the dragged node follows the cursor 1:1
      setNodes((prev) =>
        prev.map((n) =>
          n.id === dragNode ? { ...n, x: dragOriginX + dx, y: dragOriginY + dy, vx: 0, vy: 0 } : n,
        ),
      );
    } else if (isPanning) {
      const dx = (e.clientX - panStart.x) * (viewBox.width / (svgRef.current?.clientWidth || 1));
      const dy = (e.clientY - panStart.y) * (viewBox.height / (svgRef.current?.clientHeight || 1));
      setViewBox((prev) => ({ ...prev, x: panStart.vbX - dx, y: panStart.vbY - dy }));
    }
  };

  const handleMouseUp = () => {
    if (dragNode) {
      cancelAnimationFrame(dragAnimRef.current);
      setNodes((prev) => prev.map((n) => (n.id === dragNode ? { ...n, pinned: false } : n)));
      setDragNode(null);
      dragNeighborIds.current = new Set();
    }
    setIsPanning(false);
  };

  const resetView = () => {
    if (!containerRef.current) return;
    const { width, height } = containerRef.current.getBoundingClientRect();
    setViewBox({ x: -width / 2, y: -height / 2, width, height });
  };

  const zoomIn = () => {
    const f = 0.75;
    setViewBox((v) => ({
      x: v.x + (v.width * (1 - f)) / 2,
      y: v.y + (v.height * (1 - f)) / 2,
      width: v.width * f,
      height: v.height * f,
    }));
  };

  const zoomOut = () => {
    const f = 1.33;
    setViewBox((v) => ({
      x: v.x - (v.width * (f - 1)) / 2,
      y: v.y - (v.height * (f - 1)) / 2,
      width: v.width * f,
      height: v.height * f,
    }));
  };

  const fitToContent = useCallback(() => {
    if (nodes.length === 0) return;
    const pad = 120;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - NODE_W / 2 - pad;
    const maxX = Math.max(...xs) + NODE_W / 2 + pad;
    const minY = Math.min(...ys) - NODE_H / 2 - pad;
    const maxY = Math.max(...ys) + NODE_H / 2 + pad;
    setViewBox({ x: minX, y: minY, width: maxX - minX, height: maxY - minY });
  }, [nodes]);

  const toggleTypeFilter = (type: string) => {
    setTypeFilters((prev) => {
      const next = new Set(prev);
      if (next.has(type)) next.delete(type);
      else next.add(type);
      return next;
    });
  };

  // ---- Derived ----
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);
  const selectedNodeData = selectedNode ? nodeMap.get(selectedNode) : null;
  const typeCounts = useMemo(() => {
    const counts: Record<string, number> = {};
    nodes.forEach((n) => {
      counts[n.type] = (counts[n.type] || 0) + 1;
    });
    return counts;
  }, [nodes]);

  // Group nodes by type for cluster hulls
  const nodesByType = useMemo(() => {
    const map: Record<string, LayoutNode[]> = {};
    nodes
      .filter((n) => filteredNodeIds.has(n.id))
      .forEach((n) => {
        if (!map[n.type]) map[n.type] = [];
        map[n.type].push(n);
      });
    return map;
  }, [nodes, filteredNodeIds]);

  // Edges connected to selected/hovered node
  const highlightNodeId = hoveredNode || selectedNode;
  const connectedEdgeKeys = useMemo(() => {
    if (!highlightNodeId) return new Set<number>();
    const keys = new Set<number>();
    edges.forEach((e, i) => {
      if (e.source === highlightNodeId || e.target === highlightNodeId) keys.add(i);
    });
    return keys;
  }, [edges, highlightNodeId]);
  const connectedNodeIds = useMemo(() => {
    if (!highlightNodeId) return new Set<string>();
    const ids = new Set<string>();
    ids.add(highlightNodeId);
    edges.forEach((e) => {
      if (e.source === highlightNodeId) ids.add(e.target);
      if (e.target === highlightNodeId) ids.add(e.source);
    });
    return ids;
  }, [edges, highlightNodeId]);

  // Graph statistics
  const graphStats = useMemo(() => {
    if (nodes.length === 0) return null;
    const degreeMap: Record<string, number> = {};
    edges.forEach((e) => {
      degreeMap[e.source] = (degreeMap[e.source] || 0) + 1;
      degreeMap[e.target] = (degreeMap[e.target] || 0) + 1;
    });
    const degrees = Object.values(degreeMap);
    const maxDegree = Math.max(...degrees, 0);
    const avgDegree = degrees.length > 0 ? degrees.reduce((s, d) => s + d, 0) / degrees.length : 0;
    const hubNode = Object.entries(degreeMap).sort((a, b) => b[1] - a[1])[0];
    const edgeLabelCounts: Record<string, number> = {};
    edges.forEach((e) => {
      edgeLabelCounts[e.label] = (edgeLabelCounts[e.label] || 0) + 1;
    });

    return {
      nodeCount: nodes.length,
      edgeCount: edges.length,
      typeCount: Object.keys(typeCounts).length,
      maxDegree,
      avgDegree: avgDegree.toFixed(1),
      hubNode: hubNode ? nodeMap.get(hubNode[0]) : null,
      hubDegree: hubNode ? hubNode[1] : 0,
      edgeLabelCounts,
      density:
        nodes.length > 1
          ? ((2 * edges.length) / (nodes.length * (nodes.length - 1))).toFixed(3)
          : '0',
    };
  }, [nodes, edges, typeCounts, nodeMap]);

  // ---- Minimap computation ----
  const minimapData = useMemo(() => {
    if (nodes.length === 0) return null;
    const pad = 60;
    const xs = nodes.map((n) => n.x);
    const ys = nodes.map((n) => n.y);
    const minX = Math.min(...xs) - pad;
    const maxX = Math.max(...xs) + pad;
    const minY = Math.min(...ys) - pad;
    const maxY = Math.max(...ys) + pad;
    return {
      worldBox: { x: minX, y: minY, width: maxX - minX, height: maxY - minY },
    };
  }, [nodes]);

  // ---- Render ----
  if (!sprintId) return null;

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ==================== TOOLBAR ==================== */}
      <div className="flex items-center gap-2 px-4 py-2 border-b bg-background/95 backdrop-blur-sm shrink-0 z-10">
        <div className="flex items-center gap-2 mr-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary/10">
            <Network className="h-4 w-4 text-primary" />
          </div>
          <div>
            <h2 className="text-sm font-semibold leading-none">{sprint?.name || 'Sprint'} Graph</h2>
            <p className="text-[10px] text-muted-foreground mt-0.5">
              Knowledge graph visualization
            </p>
          </div>
        </div>

        <Badge variant="secondary" className="text-[10px] gap-1">
          <span className="h-1.5 w-1.5 rounded-full bg-emerald-500 animate-pulse-subtle" />
          {nodes.length} nodes
        </Badge>
        <Badge variant="outline" className="text-[10px] gap-1">
          <Share2 className="h-2.5 w-2.5" />
          {edges.length} edges
        </Badge>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Layout mode toggle */}
        <div className="flex items-center rounded-md border bg-muted/30 p-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setLayoutMode('force')}
                className={cn(
                  'flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] font-medium transition-all',
                  layoutMode === 'force'
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Orbit className="h-3 w-3" />
                Force
              </button>
            </TooltipTrigger>
            <TooltipContent>Force-directed layout (1)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => setLayoutMode('hierarchical')}
                className={cn(
                  'flex items-center gap-1 rounded-sm px-2 py-1 text-[10px] font-medium transition-all',
                  layoutMode === 'hierarchical'
                    ? 'bg-background shadow-sm text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <LayoutGrid className="h-3 w-3" />
                Hierarchy
              </button>
            </TooltipTrigger>
            <TooltipContent>Hierarchical layout (2)</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-5 mx-1" />

        {/* Search */}
        <div className="relative">
          <Search className="absolute left-2 top-1/2 -translate-y-1/2 h-3 w-3 text-muted-foreground" />
          <Input
            ref={searchRef}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search nodes... (f)"
            className="h-7 w-48 pl-7 text-xs"
          />
          {search && (
            <button
              onClick={() => setSearch('')}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="h-3 w-3" />
            </button>
          )}
        </div>

        {/* Filter toggle */}
        <Button
          variant={showFilters ? 'secondary' : 'ghost'}
          size="sm"
          className="h-7 gap-1 text-xs"
          onClick={() => setShowFilters(!showFilters)}
        >
          <Filter className="h-3 w-3" />
          Filters
          {typeFilters.size > 0 && (
            <Badge variant="default" className="h-4 px-1 text-[9px] ml-0.5">
              {typeFilters.size}
            </Badge>
          )}
        </Button>

        <div className="flex-1" />

        {/* View toggles */}
        <div className="flex items-center gap-0.5 mr-1">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showClusters ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowClusters(!showClusters)}
              >
                {showClusters ? (
                  <Eye className="h-3.5 w-3.5" />
                ) : (
                  <EyeOff className="h-3.5 w-3.5" />
                )}
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle clusters (c)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showMinimap ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowMinimap(!showMinimap)}
              >
                <MapIcon className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Toggle minimap (m)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant={showStats ? 'secondary' : 'ghost'}
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowStats(!showStats)}
              >
                <BarChart3 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Graph statistics (s)</TooltipContent>
          </Tooltip>
        </div>

        <Separator orientation="vertical" className="h-5" />

        {/* Zoom controls */}
        <div className="flex items-center gap-0.5">
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomIn}>
                <Plus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom in (+)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={zoomOut}>
                <Minus className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Zoom out (-)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button variant="ghost" size="icon" className="h-7 w-7" onClick={fitToContent}>
                <Maximize2 className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Fit to content (0)</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7"
                onClick={() => setShowKeyboardHelp(!showKeyboardHelp)}
              >
                <Keyboard className="h-3.5 w-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Keyboard shortcuts (?)</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* ==================== FILTER BAR ==================== */}
      {showFilters && (
        <div className="flex items-center gap-1.5 px-4 py-1.5 border-b bg-muted/20 shrink-0 flex-wrap">
          <span className="text-[10px] uppercase font-medium text-muted-foreground mr-1">
            Type:
          </span>
          {Object.entries(NODE_TYPES).map(([type, cfg]) => {
            const active = typeFilters.has(type);
            const count = typeCounts[type] || 0;
            if (count === 0) return null;
            return (
              <button
                key={type}
                onClick={() => toggleTypeFilter(type)}
                className={cn(
                  'flex items-center gap-1.5 px-2 py-0.5 rounded-full text-[10px] font-medium border transition-all',
                  active
                    ? 'border-foreground/20 bg-foreground/8 text-foreground shadow-sm'
                    : 'border-transparent bg-muted/50 text-muted-foreground hover:bg-muted hover:text-foreground',
                )}
              >
                <span
                  className="h-2.5 w-2.5 rounded-full shrink-0 ring-1 ring-black/10"
                  style={{ backgroundColor: cfg.color }}
                />
                {cfg.label}
                <span className="text-muted-foreground/50 tabular-nums">{count}</span>
              </button>
            );
          })}
          {typeFilters.size > 0 && (
            <button
              onClick={() => setTypeFilters(new Set())}
              className="text-[10px] text-muted-foreground hover:text-foreground ml-2 underline underline-offset-2"
            >
              Clear all
            </button>
          )}
        </div>
      )}

      {/* ==================== MAIN GRAPH AREA ==================== */}
      <div className="flex-1 relative overflow-hidden" ref={containerRef}>
        {(loading || !settled) && nodes.length !== 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 z-30">
            <div className="relative">
              <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Network className="h-8 w-8 text-primary animate-pulse" />
              </div>
              <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">
                {loading ? 'Loading graph' : 'Arranging layout'}
              </p>
              <p className="text-xs text-muted-foreground mt-0.5">
                {loading
                  ? 'Fetching sprint artifacts and relationships...'
                  : 'Settling node positions...'}
              </p>
            </div>
          </div>
        ) : loading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="relative">
              <div className="h-16 w-16 rounded-2xl bg-primary/10 flex items-center justify-center">
                <Network className="h-8 w-8 text-primary animate-pulse" />
              </div>
              <Loader2 className="absolute -bottom-1 -right-1 h-5 w-5 animate-spin text-muted-foreground" />
            </div>
            <div className="text-center">
              <p className="text-sm font-medium">Loading graph</p>
              <p className="text-xs text-muted-foreground mt-0.5">
                Fetching sprint artifacts and relationships...
              </p>
            </div>
          </div>
        ) : nodes.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <div className="h-20 w-20 rounded-2xl bg-muted/50 flex items-center justify-center">
              <Sparkles className="h-10 w-10 text-muted-foreground/40" />
            </div>
            <div className="text-center max-w-xs">
              <p className="text-sm font-semibold">No artifacts yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Run the inception agent to generate requirements, user stories, and tasks. They'll
                appear here as an interactive knowledge graph.
              </p>
            </div>
            <Button
              variant="outline"
              size="sm"
              className="mt-2 gap-1.5"
              onClick={() => navigate(`/project/${projectId}/sprint/${sprintId}`)}
            >
              <ArrowLeft className="h-3 w-3" />
              Go to Inception
            </Button>
          </div>
        ) : (
          settled && (
            <>
              {/* ===== SVG Canvas ===== */}
              <svg
                ref={svgRef}
                className={cn(
                  'w-full h-full select-none transition-opacity duration-500',
                  dragNode ? 'cursor-grabbing' : isPanning ? 'cursor-grabbing' : 'cursor-grab',
                )}
                style={{ opacity: settled ? 1 : 0 }}
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                onWheel={handleWheel}
                onMouseDown={(e) => handleMouseDown(e)}
                onMouseMove={handleMouseMove}
                onMouseUp={handleMouseUp}
                onMouseLeave={handleMouseUp}
              >
                <defs>
                  {/* Gradient definitions for each node type */}
                  {Object.entries(NODE_TYPES).map(([type, cfg]) => (
                    <linearGradient
                      key={`grad-${type}`}
                      id={`grad-${type}`}
                      x1="0"
                      y1="0"
                      x2="1"
                      y2="1"
                    >
                      <stop offset="0%" stopColor={cfg.gradientFrom} />
                      <stop offset="100%" stopColor={cfg.gradientTo} />
                    </linearGradient>
                  ))}

                  {/* Arrow markers */}
                  <marker
                    id="arrow"
                    markerWidth="10"
                    markerHeight="7"
                    refX="10"
                    refY="3.5"
                    orient="auto"
                  >
                    <polygon points="0 0, 10 3.5, 0 7" className="fill-muted-foreground/30" />
                  </marker>
                  <marker
                    id="arrow-highlight"
                    markerWidth="10"
                    markerHeight="7"
                    refX="10"
                    refY="3.5"
                    orient="auto"
                  >
                    <polygon points="0 0, 10 3.5, 0 7" className="fill-foreground/50" />
                  </marker>

                  {/* Filters */}
                  <filter id="node-shadow" x="-20%" y="-20%" width="140%" height="140%">
                    <feDropShadow dx="0" dy="3" stdDeviation="5" floodOpacity="0.12" />
                  </filter>
                  <filter id="node-glow" x="-40%" y="-40%" width="180%" height="180%">
                    <feGaussianBlur stdDeviation="8" result="blur" />
                    <feMerge>
                      <feMergeNode in="blur" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>
                  <filter id="node-selected" x="-30%" y="-30%" width="160%" height="160%">
                    <feGaussianBlur stdDeviation="4" result="blur" />
                    <feFlood floodColor="var(--primary)" floodOpacity="0.3" result="color" />
                    <feComposite in="color" in2="blur" operator="in" result="glow" />
                    <feMerge>
                      <feMergeNode in="glow" />
                      <feMergeNode in="SourceGraphic" />
                    </feMerge>
                  </filter>

                  {/* Animated dash pattern for flowing edges */}
                  <pattern id="flow-pattern" width="20" height="4" patternUnits="userSpaceOnUse">
                    <circle cx="2" cy="2" r="1.5" className="fill-foreground/30" />
                  </pattern>
                </defs>

                {/* Grid pattern background */}
                <pattern id="grid-dots" width="40" height="40" patternUnits="userSpaceOnUse">
                  <circle cx="20" cy="20" r="0.6" className="fill-muted-foreground/8" />
                </pattern>
                <rect
                  x={viewBox.x - 5000}
                  y={viewBox.y - 5000}
                  width={viewBox.width + 10000}
                  height={viewBox.height + 10000}
                  fill="url(#grid-dots)"
                />

                {/* ===== Cluster hulls ===== */}
                {showClusters &&
                  Object.entries(nodesByType).map(([type, typeNodes]) => {
                    if (typeNodes.length < 2) return null;
                    const cfg = NODE_TYPES[type];
                    if (!cfg) return null;
                    const path = hullPath(typeNodes, NODE_W * 0.8);
                    if (!path) return null;
                    return (
                      <g key={`hull-${type}`} opacity={highlightNodeId ? 0.05 : 0.06}>
                        <path
                          d={path}
                          fill={cfg.color}
                          stroke={cfg.color}
                          strokeWidth={1.5}
                          strokeDasharray="6 4"
                          strokeOpacity={0.3}
                          fillOpacity={1}
                        />
                      </g>
                    );
                  })}

                {/* ===== Edges ===== */}
                {filteredEdges.map((edge, i) => {
                  const s = nodeMap.get(edge.source);
                  const t = nodeMap.get(edge.target);
                  if (!s || !t) return null;
                  const dx = t.x - s.x;
                  const dy = t.y - s.y;
                  const dist = Math.max(Math.sqrt(dx * dx + dy * dy), 1);
                  const pad = NODE_W / 2 + 10;
                  const sx = s.x + (dx / dist) * pad;
                  const sy = s.y + (dy / dist) * pad;
                  const tx = t.x - (dx / dist) * pad;
                  const ty = t.y - (dy / dist) * pad;
                  const mx = (sx + tx) / 2;
                  const my = (sy + ty) / 2;
                  const isHighlighted = connectedEdgeKeys.has(edges.indexOf(edge));
                  const dimmed = highlightNodeId && !isHighlighted;

                  // Flowing particle position
                  const edgeDist = Math.sqrt((tx - sx) ** 2 + (ty - sy) ** 2);
                  const particleProgress = ((animationTime * 80 + i * 37) % edgeDist) / edgeDist;
                  const px = sx + (tx - sx) * particleProgress;
                  const py = sy + (ty - sy) * particleProgress;

                  return (
                    <g
                      key={`e-${i}`}
                      className="transition-opacity duration-300"
                      opacity={dimmed ? 0.08 : 1}
                    >
                      {/* Edge line */}
                      <line
                        x1={sx}
                        y1={sy}
                        x2={tx}
                        y2={ty}
                        className={cn(
                          isHighlighted ? 'text-foreground/40' : 'text-muted-foreground/18',
                        )}
                        stroke="currentColor"
                        strokeWidth={isHighlighted ? 2.5 : 1.5}
                        strokeLinecap="round"
                        markerEnd={isHighlighted ? 'url(#arrow-highlight)' : 'url(#arrow)'}
                      />

                      {/* Flowing particle */}
                      {!dimmed && (
                        <circle
                          cx={px}
                          cy={py}
                          r={isHighlighted ? 3 : 2}
                          className={
                            isHighlighted ? 'fill-foreground/40' : 'fill-muted-foreground/25'
                          }
                        />
                      )}

                      {/* Edge label */}
                      <text
                        x={mx}
                        y={my - 8}
                        textAnchor="middle"
                        className={cn(
                          'text-[8px] fill-current select-none',
                          isHighlighted
                            ? 'text-foreground/50 font-semibold'
                            : 'text-muted-foreground/25',
                        )}
                      >
                        {EDGE_LABELS[edge.label] || edge.label}
                      </text>
                    </g>
                  );
                })}

                {/* ===== Nodes ===== */}
                {nodes
                  .filter((n) => filteredNodeIds.has(n.id))
                  .map((node) => {
                    const cfg = NODE_TYPES[node.type];
                    const isSelected = selectedNode === node.id;
                    const isHovered = hoveredNode === node.id;
                    const isConnected = connectedNodeIds.has(node.id);
                    const dimmed = highlightNodeId && !isConnected;
                    const IconComp = cfg?.icon;

                    return (
                      <g
                        key={node.id}
                        transform={`translate(${node.x}, ${node.y})`}
                        onMouseDown={(e) => {
                          e.stopPropagation();
                          handleMouseDown(e, node.id);
                        }}
                        onMouseEnter={() => setHoveredNode(node.id)}
                        onMouseLeave={() => setHoveredNode(null)}
                        onClick={() =>
                          setSelectedNode((prev) => (prev === node.id ? null : node.id))
                        }
                        className="cursor-pointer"
                        opacity={dimmed ? 0.15 : 1}
                        style={{ transition: 'opacity 300ms ease' }}
                        filter={
                          isSelected
                            ? 'url(#node-selected)'
                            : isHovered
                              ? 'url(#node-glow)'
                              : 'url(#node-shadow)'
                        }
                      >
                        {/* Selection ring */}
                        {isSelected && (
                          <rect
                            x={-NODE_W / 2 - 5}
                            y={-NODE_H / 2 - 5}
                            width={NODE_W + 10}
                            height={NODE_H + 10}
                            rx={NODE_RX + 3}
                            fill="none"
                            stroke={cfg?.color || '#888'}
                            strokeWidth={2}
                            strokeDasharray="5 4"
                            opacity={0.7}
                          >
                            <animate
                              attributeName="stroke-dashoffset"
                              from="0"
                              to="18"
                              dur="1.5s"
                              repeatCount="indefinite"
                            />
                          </rect>
                        )}

                        {/* Hover ring */}
                        {isHovered && !isSelected && (
                          <rect
                            x={-NODE_W / 2 - 3}
                            y={-NODE_H / 2 - 3}
                            width={NODE_W + 6}
                            height={NODE_H + 6}
                            rx={NODE_RX + 2}
                            fill="none"
                            stroke={cfg?.color || '#888'}
                            strokeWidth={1.5}
                            opacity={0.4}
                          />
                        )}

                        {/* Node body */}
                        <rect
                          x={-NODE_W / 2}
                          y={-NODE_H / 2}
                          width={NODE_W}
                          height={NODE_H}
                          rx={NODE_RX}
                          fill={cfg ? `url(#grad-${node.type})` : '#888'}
                        />

                        {/* Subtle inner highlight */}
                        <rect
                          x={-NODE_W / 2 + 1}
                          y={-NODE_H / 2 + 1}
                          width={NODE_W - 2}
                          height={NODE_H / 2 - 1}
                          rx={NODE_RX - 1}
                          fill="white"
                          opacity={0.12}
                        />

                        {/* Icon circle */}
                        <circle cx={-NODE_W / 2 + 20} cy={0} r={13} fill="rgba(0,0,0,0.15)" />

                        {/* Icon (rendered as SVG foreignObject) */}
                        <foreignObject
                          x={-NODE_W / 2 + 20 - ICON_SIZE / 2}
                          y={-ICON_SIZE / 2}
                          width={ICON_SIZE}
                          height={ICON_SIZE}
                        >
                          {IconComp && <IconComp className="h-full w-full text-white/90" />}
                        </foreignObject>

                        {/* Type label */}
                        <text
                          x={6}
                          y={-6}
                          textAnchor="middle"
                          fill={cfg?.textColor || '#fff'}
                          fontSize={8}
                          fontWeight={700}
                          letterSpacing={0.8}
                          opacity={0.7}
                        >
                          {(cfg?.shortLabel || node.type).toUpperCase()}
                        </text>

                        {/* Node label */}
                        <text
                          x={6}
                          y={10}
                          textAnchor="middle"
                          fill={cfg?.textColor || '#fff'}
                          fontSize={10}
                          fontWeight={500}
                        >
                          {(node.label || '').length > 18
                            ? (node.label || '').slice(0, 16) + '...'
                            : node.label || ''}
                        </text>
                      </g>
                    );
                  })}
              </svg>

              {/* ===== Minimap ===== */}
              {showMinimap && minimapData && nodes.length > 3 && (
                <div className="absolute bottom-3 right-3 z-10">
                  <Card className="bg-background/90 backdrop-blur-sm shadow-lg overflow-hidden">
                    <div className="px-2 py-1 border-b flex items-center gap-1.5">
                      <MapIcon className="h-2.5 w-2.5 text-muted-foreground" />
                      <span className="text-[9px] font-medium text-muted-foreground">Minimap</span>
                    </div>
                    <CardContent className="p-1.5">
                      <svg
                        width="160"
                        height="100"
                        viewBox={`${minimapData.worldBox.x} ${minimapData.worldBox.y} ${minimapData.worldBox.width} ${minimapData.worldBox.height}`}
                        className="bg-muted/30 rounded"
                      >
                        {/* Edges */}
                        {filteredEdges.map((edge, i) => {
                          const s = nodeMap.get(edge.source);
                          const t = nodeMap.get(edge.target);
                          if (!s || !t) return null;
                          return (
                            <line
                              key={`me-${i}`}
                              x1={s.x}
                              y1={s.y}
                              x2={t.x}
                              y2={t.y}
                              stroke="currentColor"
                              className="text-muted-foreground/15"
                              strokeWidth={Math.max(minimapData.worldBox.width / 200, 1)}
                            />
                          );
                        })}
                        {/* Nodes */}
                        {nodes
                          .filter((n) => filteredNodeIds.has(n.id))
                          .map((node) => {
                            const cfg = NODE_TYPES[node.type];
                            const r = Math.max(minimapData.worldBox.width / 100, 3);
                            return (
                              <circle
                                key={`mn-${node.id}`}
                                cx={node.x}
                                cy={node.y}
                                r={r}
                                fill={cfg?.color || '#888'}
                                opacity={selectedNode === node.id ? 1 : 0.7}
                                stroke={selectedNode === node.id ? '#fff' : 'none'}
                                strokeWidth={r * 0.5}
                              />
                            );
                          })}
                        {/* Viewport rectangle */}
                        <rect
                          x={viewBox.x}
                          y={viewBox.y}
                          width={viewBox.width}
                          height={viewBox.height}
                          fill="none"
                          stroke="currentColor"
                          className="text-foreground/40"
                          strokeWidth={Math.max(minimapData.worldBox.width / 200, 1.5)}
                          strokeDasharray="6 3"
                        />
                      </svg>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* ===== Legend (bottom-left) ===== */}
              {!loading && nodes.length > 0 && (
                <div className="absolute bottom-3 left-3 z-10">
                  <Card className="bg-background/90 backdrop-blur-sm shadow-lg">
                    <div className="px-2.5 py-1.5 border-b">
                      <span className="text-[9px] font-semibold text-muted-foreground uppercase tracking-wider">
                        Legend
                      </span>
                    </div>
                    <CardContent className="p-2 space-y-1">
                      {Object.entries(NODE_TYPES).map(([type, cfg]) => {
                        const count = typeCounts[type] || 0;
                        if (count === 0) return null;
                        const Icon = cfg.icon;
                        return (
                          <button
                            key={type}
                            className={cn(
                              'flex items-center gap-2 w-full text-left rounded px-1 py-0.5 transition-colors hover:bg-muted/50',
                              typeFilters.has(type) && 'bg-muted',
                            )}
                            onClick={() => toggleTypeFilter(type)}
                          >
                            <span
                              className="h-3 w-3 rounded shrink-0 shadow-sm ring-1 ring-black/5"
                              style={{
                                background: `linear-gradient(135deg, ${cfg.gradientFrom}, ${cfg.gradientTo})`,
                              }}
                            />
                            <Icon className="h-3 w-3 text-muted-foreground" />
                            <span className="text-[10px] text-foreground/80 flex-1">
                              {cfg.label}
                            </span>
                            <span className="text-[10px] tabular-nums font-medium text-muted-foreground/60">
                              {count}
                            </span>
                          </button>
                        );
                      })}
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* ===== Statistics Panel (top-left) ===== */}
              {showStats && graphStats && (
                <div className="absolute top-3 left-3 z-10 w-56">
                  <Card className="bg-background/90 backdrop-blur-sm shadow-lg">
                    <div className="px-3 py-2 border-b flex items-center justify-between">
                      <div className="flex items-center gap-1.5">
                        <BarChart3 className="h-3 w-3 text-muted-foreground" />
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Graph Statistics
                        </span>
                      </div>
                      <button
                        onClick={() => setShowStats(false)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </div>
                    <CardContent className="p-3 space-y-2.5">
                      <div className="grid grid-cols-2 gap-2">
                        <StatItem label="Nodes" value={String(graphStats.nodeCount)} />
                        <StatItem label="Edges" value={String(graphStats.edgeCount)} />
                        <StatItem label="Types" value={String(graphStats.typeCount)} />
                        <StatItem label="Density" value={graphStats.density} />
                        <StatItem label="Max Degree" value={String(graphStats.maxDegree)} />
                        <StatItem label="Avg Degree" value={graphStats.avgDegree} />
                      </div>
                      {graphStats.hubNode && (
                        <>
                          <Separator />
                          <div>
                            <span className="text-[9px] uppercase font-medium text-muted-foreground tracking-wider">
                              Hub Node
                            </span>
                            <div className="flex items-center gap-1.5 mt-1">
                              <span
                                className="h-2.5 w-2.5 rounded shrink-0"
                                style={{
                                  backgroundColor:
                                    NODE_TYPES[graphStats.hubNode.type]?.color || '#888',
                                }}
                              />
                              <span className="text-[11px] font-medium truncate">
                                {graphStats.hubNode.label}
                              </span>
                              <Badge
                                variant="secondary"
                                className="h-4 px-1 text-[8px] ml-auto shrink-0"
                              >
                                {graphStats.hubDegree} links
                              </Badge>
                            </div>
                          </div>
                        </>
                      )}
                      <Separator />
                      <div>
                        <span className="text-[9px] uppercase font-medium text-muted-foreground tracking-wider">
                          Edge Types
                        </span>
                        <div className="mt-1 space-y-0.5">
                          {Object.entries(graphStats.edgeLabelCounts)
                            .sort((a, b) => b[1] - a[1])
                            .map(([label, count]) => (
                              <div key={label} className="flex items-center justify-between">
                                <span className="text-[10px] text-muted-foreground">
                                  {EDGE_LABELS[label] || label}
                                </span>
                                <span className="text-[10px] tabular-nums font-medium">
                                  {count}
                                </span>
                              </div>
                            ))}
                        </div>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}

              {/* ===== Keyboard shortcuts help ===== */}
              {showKeyboardHelp && (
                <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20">
                  <Card className="bg-background/95 backdrop-blur-sm shadow-xl">
                    <div className="px-4 py-2 border-b flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <Keyboard className="h-3.5 w-3.5 text-muted-foreground" />
                        <span className="text-xs font-semibold">Keyboard Shortcuts</span>
                      </div>
                      <button
                        onClick={() => setShowKeyboardHelp(false)}
                        className="text-muted-foreground hover:text-foreground"
                      >
                        <X className="h-3.5 w-3.5" />
                      </button>
                    </div>
                    <CardContent className="p-3">
                      <div className="grid grid-cols-2 gap-x-8 gap-y-1">
                        {[
                          ['f or /', 'Search nodes'],
                          ['1', 'Force layout'],
                          ['2', 'Hierarchical layout'],
                          ['c', 'Toggle clusters'],
                          ['m', 'Toggle minimap'],
                          ['s', 'Toggle statistics'],
                          ['+ / -', 'Zoom in / out'],
                          ['0', 'Fit to content'],
                          ['Esc', 'Clear selection'],
                          ['?', 'This help'],
                        ].map(([key, desc]) => (
                          <div key={key} className="flex items-center gap-2 py-0.5">
                            <kbd className="inline-flex h-5 items-center rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground min-w-[28px] justify-center">
                              {key}
                            </kbd>
                            <span className="text-[11px] text-muted-foreground">{desc}</span>
                          </div>
                        ))}
                      </div>
                    </CardContent>
                  </Card>
                </div>
              )}
            </>
          )
        )}

        {/* ==================== DETAIL PANEL ==================== */}
        {selectedNodeData &&
          (() => {
            const cfg = NODE_TYPES[selectedNodeData.type];
            const nodeEdges = edges.filter(
              (e) => e.source === selectedNode || e.target === selectedNode,
            );
            const outgoing = nodeEdges.filter((e) => e.source === selectedNode);
            const incoming = nodeEdges.filter((e) => e.target === selectedNode);

            return (
              <div className="absolute top-0 right-0 bottom-0 w-80 z-20 border-l bg-background/95 backdrop-blur-sm shadow-2xl flex flex-col">
                {/* Header with colored accent */}
                <div
                  className="shrink-0 px-4 pt-4 pb-3"
                  style={{ borderBottom: `2px solid ${cfg?.color || '#888'}` }}
                >
                  <div className="flex items-start justify-between">
                    <div className="flex items-start gap-3 min-w-0 flex-1">
                      <div
                        className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-md"
                        style={{
                          background: `linear-gradient(135deg, ${cfg?.gradientFrom || '#888'}, ${cfg?.gradientTo || '#666'})`,
                        }}
                      >
                        {(() => {
                          const Icon = cfg?.icon;
                          return Icon ? <Icon className="h-5 w-5 text-white" /> : null;
                        })()}
                      </div>
                      <div className="min-w-0 flex-1">
                        <span
                          className="text-[10px] font-medium uppercase tracking-wider"
                          style={{ color: cfg?.color || '#888' }}
                        >
                          {cfg?.label || selectedNodeData.type}
                        </span>
                        <h3 className="text-sm font-semibold mt-0.5 leading-snug">
                          {selectedNodeData.label}
                        </h3>
                      </div>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 -mt-1 -mr-1"
                      onClick={() => setSelectedNode(null)}
                    >
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>

                  {/* Quick stats row */}
                  <div className="flex items-center gap-3 mt-3">
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <ArrowRight className="h-3 w-3" />
                      <span>{outgoing.length} outgoing</span>
                    </div>
                    <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
                      <ArrowLeft className="h-3 w-3" />
                      <span>{incoming.length} incoming</span>
                    </div>
                  </div>
                </div>

                <ScrollArea className="flex-1">
                  <div className="p-4 space-y-5">
                    {/* ---- Content section (type-aware) ---- */}
                    <NodeDetailContent node={selectedNodeData} />

                    {/* ---- Relationships ---- */}
                    {nodeEdges.length > 0 && (
                      <div>
                        <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
                          Relationships
                        </span>

                        {/* Outgoing */}
                        {outgoing.length > 0 && (
                          <div className="mt-2">
                            <span className="text-[9px] uppercase text-muted-foreground/60 tracking-wider font-medium flex items-center gap-1 mb-1">
                              <ArrowRight className="h-2.5 w-2.5" /> Outgoing
                            </span>
                            <div className="space-y-0.5">
                              {outgoing.map((edge, i) => {
                                const other = nodeMap.get(edge.target);
                                if (!other) return null;
                                const otherCfg = NODE_TYPES[other.type];
                                return (
                                  <button
                                    key={`o-${i}`}
                                    className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors group"
                                    onClick={() => setSelectedNode(edge.target)}
                                  >
                                    <span
                                      className="h-2.5 w-2.5 rounded shrink-0 ring-1 ring-black/5"
                                      style={{ backgroundColor: otherCfg?.color || '#888' }}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <span className="text-[11px] truncate block font-medium">
                                        {other.label}
                                      </span>
                                      <span className="text-[9px] text-muted-foreground/60">
                                        {EDGE_LABELS[edge.label] || edge.label} &middot;{' '}
                                        {otherCfg?.label || other.type}
                                      </span>
                                    </div>
                                    <ChevronRight className="h-3 w-3 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}

                        {/* Incoming */}
                        {incoming.length > 0 && (
                          <div className="mt-2">
                            <span className="text-[9px] uppercase text-muted-foreground/60 tracking-wider font-medium flex items-center gap-1 mb-1">
                              <ArrowLeft className="h-2.5 w-2.5" /> Incoming
                            </span>
                            <div className="space-y-0.5">
                              {incoming.map((edge, i) => {
                                const other = nodeMap.get(edge.source);
                                if (!other) return null;
                                const otherCfg = NODE_TYPES[other.type];
                                return (
                                  <button
                                    key={`i-${i}`}
                                    className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors group"
                                    onClick={() => setSelectedNode(edge.source)}
                                  >
                                    <span
                                      className="h-2.5 w-2.5 rounded shrink-0 ring-1 ring-black/5"
                                      style={{ backgroundColor: otherCfg?.color || '#888' }}
                                    />
                                    <div className="flex-1 min-w-0">
                                      <span className="text-[11px] truncate block font-medium">
                                        {other.label}
                                      </span>
                                      <span className="text-[9px] text-muted-foreground/60">
                                        {EDGE_LABELS[edge.label] || edge.label} &middot;{' '}
                                        {otherCfg?.label || other.type}
                                      </span>
                                    </div>
                                    <ChevronRight className="h-3 w-3 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                                  </button>
                                );
                              })}
                            </div>
                          </div>
                        )}
                      </div>
                    )}

                    {nodeEdges.length === 0 && (
                      <div className="rounded-lg border border-dashed p-3 text-center">
                        <p className="text-[11px] text-muted-foreground">No relationships yet</p>
                      </div>
                    )}
                  </div>
                </ScrollArea>
              </div>
            );
          })()}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat Item
// ---------------------------------------------------------------------------

function StatItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-md bg-muted/30 px-2 py-1.5">
      <span className="text-[9px] uppercase text-muted-foreground/60 tracking-wider">{label}</span>
      <p className="text-sm font-bold tabular-nums leading-none mt-0.5">{value}</p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: safely get a string property from a node
// ---------------------------------------------------------------------------

function str(node: GraphNode, key: string): string {
  const v = node[key];
  if (v == null || v === '') return '';
  return String(v);
}

function tryParseJson(raw: string): unknown | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status badge component
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  todo: 'bg-muted text-muted-foreground',
  in_progress: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  PENDING: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  PASSED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  FAILED: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

function StatusBadge({ status }: { status: string }) {
  const display = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
        STATUS_STYLES[status] || 'bg-muted text-muted-foreground',
      )}
    >
      {display}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detail field helper
// ---------------------------------------------------------------------------

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-[10px] uppercase font-medium text-muted-foreground/60 tracking-wider">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function DetailText({ value, limit = 600 }: { value: string; limit?: number }) {
  if (!value) return <p className="text-[11px] text-muted-foreground/40 italic">Not provided</p>;
  const display = value.length > limit ? value.slice(0, limit) + '...' : value;
  return <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{display}</p>;
}

// ---------------------------------------------------------------------------
// Node Detail Content -- type-aware rendering
// ---------------------------------------------------------------------------

function NodeDetailContent({ node }: { node: LayoutNode }) {
  const type = node.type;

  switch (type) {
    case 'Requirement': {
      const description = str(node, 'description');
      const criteria = str(node, 'acceptance_criteria');
      return (
        <div className="space-y-3">
          {description && (
            <DetailField label="Description">
              <DetailText value={description} />
            </DetailField>
          )}
          {criteria && (
            <DetailField label="Acceptance Criteria">
              <DetailText value={criteria} />
            </DetailField>
          )}
          {!description && !criteria && <EmptyContent />}
        </div>
      );
    }

    case 'UserStory': {
      const description = str(node, 'description');
      const points = str(node, 'story_points');
      return (
        <div className="space-y-3">
          {points && points !== '0' && (
            <DetailField label="Story Points">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {points}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  point{points !== '1' ? 's' : ''} estimated
                </span>
              </div>
            </DetailField>
          )}
          {description && (
            <DetailField label="Description">
              <DetailText value={description} />
            </DetailField>
          )}
          {!description && (!points || points === '0') && <EmptyContent />}
        </div>
      );
    }

    case 'Task': {
      const status = str(node, 'status');
      const description = str(node, 'description');
      const deps = str(node, 'dependencies');
      const depList = tryParseJson(deps);
      const depCount = Array.isArray(depList) ? depList.length : 0;
      return (
        <div className="space-y-3">
          {status && (
            <DetailField label="Status">
              <StatusBadge status={status} />
            </DetailField>
          )}
          {description && (
            <DetailField label="Description">
              <DetailText value={description} />
            </DetailField>
          )}
          {depCount > 0 && (
            <DetailField label="Dependencies">
              <span className="text-xs text-muted-foreground">
                {depCount} task{depCount !== 1 ? 's' : ''} must complete first
              </span>
            </DetailField>
          )}
          {!status && !description && <EmptyContent />}
        </div>
      );
    }

    case 'CodeFile': {
      const filePath = str(node, 'file_path');
      const summary = str(node, 'summary');
      const commitRef = str(node, 'commit_ref');
      return (
        <div className="space-y-3">
          {filePath && (
            <DetailField label="File Path">
              <code className="text-[11px] font-mono bg-muted/40 rounded px-1.5 py-0.5 break-all">
                {filePath}
              </code>
            </DetailField>
          )}
          {summary && (
            <DetailField label="Summary">
              <DetailText value={summary} />
            </DetailField>
          )}
          {commitRef && (
            <DetailField label="Commit">
              <code className="text-[10px] font-mono text-muted-foreground bg-muted/40 rounded px-1.5 py-0.5">
                {commitRef.slice(0, 12)}
              </code>
            </DetailField>
          )}
          {!filePath && !summary && <EmptyContent />}
        </div>
      );
    }

    case 'Review': {
      const status = str(node, 'status');
      const comments = str(node, 'comments');
      const blindReview = str(node, 'blind_review');
      const fullReview = str(node, 'full_review');
      return (
        <div className="space-y-3">
          {status && (
            <DetailField label="Review Status">
              <StatusBadge status={status} />
            </DetailField>
          )}
          {comments && (
            <DetailField label="Comments">
              <DetailText value={comments} />
            </DetailField>
          )}
          {blindReview && (
            <DetailField label="Technical Review">
              <DetailText value={blindReview} />
            </DetailField>
          )}
          {fullReview && (
            <DetailField label="Business Review">
              <DetailText value={fullReview} />
            </DetailField>
          )}
          {!status && !comments && !blindReview && !fullReview && <EmptyContent />}
        </div>
      );
    }

    case 'Question': {
      const rawQuestions = str(node, 'questions');
      const agent = str(node, 'agent');
      const rawAnswer = str(node, 'structured_answer');
      const parsedQuestions = tryParseJson(rawQuestions) as Array<{
        text?: string;
        question?: string;
        type?: string;
        options?: Array<{ label: string; description?: string }>;
      }> | null;
      const parsedAnswer = tryParseJson(rawAnswer) as {
        answers?: Array<{ selectedOptions?: number[]; freeText?: string }>;
      } | null;
      const answerItems = parsedAnswer?.answers;

      return (
        <div className="space-y-3">
          {agent && (
            <DetailField label="Asked by">
              <span className="text-xs font-medium capitalize">{agent} agent</span>
            </DetailField>
          )}
          {Array.isArray(parsedQuestions) && parsedQuestions.length > 0 && (
            <div className="space-y-3">
              {parsedQuestions.map((q, i) => {
                const questionText = q?.text || q?.question || '';
                const options = q?.options;
                const a = Array.isArray(answerItems) ? answerItems[i] : null;
                const selectedIdxs = a?.selectedOptions || [];
                const freeText = a?.freeText || '';
                const hasAnswer = selectedIdxs.length > 0 || !!freeText;

                return (
                  <div key={i} className="rounded-lg border overflow-hidden">
                    {/* Question */}
                    <div className="bg-muted/30 px-3 py-2">
                      <span className="text-[9px] uppercase font-medium text-muted-foreground/60 tracking-wider">
                        Question {parsedQuestions.length > 1 ? i + 1 : ''}
                      </span>
                      <p className="text-xs leading-relaxed mt-0.5 font-medium">{questionText}</p>
                    </div>

                    {/* Answer */}
                    {hasAnswer && (
                      <div className="px-3 py-2 bg-emerald-500/5">
                        <span className="text-[9px] uppercase font-medium text-emerald-600 dark:text-emerald-400 tracking-wider">
                          Answer
                        </span>
                        {selectedIdxs.length > 0 && Array.isArray(options) && (
                          <div className="mt-1 space-y-0.5">
                            {selectedIdxs.map((idx) => {
                              const opt = options[idx];
                              return (
                                <div key={idx} className="flex items-start gap-1.5">
                                  <span className="text-emerald-600 dark:text-emerald-400 text-xs mt-0.5 shrink-0">
                                    &#10003;
                                  </span>
                                  <span className="text-xs">
                                    {opt?.label || `Option ${idx + 1}`}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {freeText && (
                          <p className="text-xs leading-relaxed mt-1 text-foreground/80 italic">
                            {freeText}
                          </p>
                        )}
                      </div>
                    )}

                    {!hasAnswer && (
                      <div className="px-3 py-2">
                        <span className="text-[10px] text-muted-foreground/50 italic">
                          Awaiting answer
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!Array.isArray(parsedQuestions) && !agent && <EmptyContent />}
        </div>
      );
    }

    case 'GeneralInfo': {
      const infoType = str(node, 'type');
      const content = str(node, 'content');
      return (
        <div className="space-y-3">
          {infoType && infoType !== 'GeneralInfo' && (
            <DetailField label="Category">
              <Badge variant="outline" className="text-[10px]">
                {infoType}
              </Badge>
            </DetailField>
          )}
          {content && (
            <DetailField label="Content">
              <DetailText value={content} />
            </DetailField>
          )}
          {!content && <EmptyContent />}
        </div>
      );
    }

    case 'PullRequest': {
      const prUrl = str(node, 'pr_url');
      const prNumber = str(node, 'pr_number');
      const branch = str(node, 'branch');
      const baseBranch = str(node, 'base_branch');
      return (
        <div className="space-y-3">
          {prNumber && (
            <DetailField label="Pull Request">
              <span className="text-xs font-semibold">#{prNumber}</span>
            </DetailField>
          )}
          {branch && (
            <DetailField label="Branch">
              <div className="flex items-center gap-1.5 text-[11px]">
                <code className="font-mono bg-muted/40 rounded px-1.5 py-0.5">{branch}</code>
                {baseBranch && (
                  <>
                    <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                    <code className="font-mono bg-muted/40 rounded px-1.5 py-0.5">
                      {baseBranch}
                    </code>
                  </>
                )}
              </div>
            </DetailField>
          )}
          {prUrl && (
            <DetailField label="Link">
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline underline-offset-2 break-all"
              >
                Open link
              </a>
            </DetailField>
          )}
          {!prNumber && !prUrl && <EmptyContent />}
        </div>
      );
    }

    default: {
      // Fallback: show any non-internal properties
      const internalKeys = new Set([
        'id',
        'type',
        'label',
        'x',
        'y',
        'vx',
        'vy',
        'pinned',
        'sprint_id',
        'createdAt',
        'created_at',
      ]);
      const entries = Object.entries(node)
        .filter(([k]) => !internalKeys.has(k))
        .filter(([, v]) => v != null && v !== '');
      if (entries.length === 0) return <EmptyContent />;
      return (
        <div className="space-y-3">
          {entries.map(([key, value]) => (
            <DetailField key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}>
              <DetailText value={String(value)} />
            </DetailField>
          ))}
        </div>
      );
    }
  }
}

function EmptyContent() {
  return (
    <div className="rounded-lg border border-dashed p-3 text-center">
      <p className="text-[11px] text-muted-foreground">No details available yet</p>
    </div>
  );
}
