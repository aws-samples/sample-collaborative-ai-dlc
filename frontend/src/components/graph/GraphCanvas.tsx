import { useState, useEffect, useRef, useCallback, useMemo, type ReactNode } from 'react';
import { type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { cn } from '@/lib/utils';
import { Network, Loader2, Sparkles } from 'lucide-react';
import {
  NODE_TYPES,
  NODE_W,
  NODE_H,
  NODE_RX,
  ICON_SIZE,
  TYPE_HIERARCHY,
  EDGE_LABELS,
  getNodeCfg,
  hullPath,
  deriveNodeLabel,
  splitLabelTwoLines,
  type LayoutNode,
  type ViewBox,
  type LayoutMode,
} from './graphTypes';
import { GraphToolbar } from './GraphToolbar';
import { GraphFilterBar } from './GraphFilterBar';
import { GraphNodePanel } from './GraphNodePanel';
import { GraphStatsPanel, type GraphStats } from './GraphStatsPanel';
import { GraphLegend } from './GraphLegend';
import { GraphMinimap } from './GraphMinimap';
import { GraphZoomControls } from './GraphZoomControls';
import { GraphKeyboardHelp } from './GraphKeyboardHelp';

// Re-export for consumers that imported NODE_TYPES from GraphCanvas
export { NODE_TYPES };

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  title?: string;
  loading?: boolean;
  error?: string | null;
  emptyState?: ReactNode;
  headerLeading?: ReactNode;
}

// ---------------------------------------------------------------------------
// GraphCanvas Component
// ---------------------------------------------------------------------------

export function GraphCanvas({
  nodes: rawNodes,
  edges: rawEdges,
  title,
  loading = false,
  error,
  emptyState,
  headerLeading,
}: GraphCanvasProps) {
  // Internal layout state
  const [nodes, setNodes] = useState<LayoutNode[]>([]);
  const [edges, setEdges] = useState<GraphEdge[]>([]);
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
  const energyRef = useRef<number>(Infinity);
  const particleAnimRef = useRef<number>(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  // ---- Settle layout when raw data changes ----
  useEffect(() => {
    if (rawNodes.length === 0) {
      setNodes([]);
      setEdges([]);
      setSettled(false);
      return;
    }

    setSettled(false);

    const layoutNodes: LayoutNode[] = rawNodes.map((node, i) => ({
      ...node,
      label: deriveNodeLabel(node),
      x: 400 * Math.cos((2 * Math.PI * i) / Math.max(rawNodes.length, 1)),
      y: 400 * Math.sin((2 * Math.PI * i) / Math.max(rawNodes.length, 1)),
      vx: 0,
      vy: 0,
    }));

    // Run force simulation synchronously to settle the layout before rendering
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
      for (const edge of rawEdges) {
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

    setNodes(layoutNodes);
    setEdges(rawEdges);
    requestAnimationFrame(() => setSettled(true));
  }, [rawNodes, rawEdges]);

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

      // Recorded here (fresh post-integration values) because the settle loop's
      // effect closure only sees a stale `nodes` snapshot — reading energy there
      // reported 0 after a hierarchy switch and killed the re-settle instantly.
      energyRef.current = next.reduce((sum, n) => sum + n.vx * n.vx + n.vy * n.vy, 0);

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

    // Force mode: only run a brief re-settle (e.g. after switching from hierarchical).
    // Early-exit when total kinetic energy drops below threshold — most graphs
    // converge well before the 120-frame cap, saving redundant force iterations.
    // WARMUP_FRAMES lets repulsion re-inject velocity first: a hierarchy switch
    // zeroes all velocities, so frame-1 energy is always ~0 and would exit early.
    let frame = 0;
    const ENERGY_THRESHOLD = 0.5;
    const WARMUP_FRAMES = 15;
    energyRef.current = Infinity;
    const tick = () => {
      if (frame < 120) {
        simulate();
        frame++;
        if (frame > WARMUP_FRAMES && energyRef.current < ENERGY_THRESHOLD) return;
        animRef.current = requestAnimationFrame(tick);
      }
    };
    animRef.current = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(animRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, simulate, layoutMode, applyHierarchicalLayout]);

  // ---- Particle animation loop ----
  // Throttled to ~15fps (66ms frame budget) to avoid re-rendering the full SVG
  // tree at 60fps. Paused entirely while the tab is hidden.
  useEffect(() => {
    if (nodes.length === 0 || !settled) return;
    let time = 0;
    let lastFrame = 0;
    const FRAME_BUDGET_MS = 66; // ~15fps
    const tick = (now: number) => {
      if (now - lastFrame >= FRAME_BUDGET_MS) {
        lastFrame = now;
        time += 0.008;
        setAnimationTime(time);
      }
      particleAnimRef.current = requestAnimationFrame(tick);
    };
    const start = () => {
      cancelAnimationFrame(particleAnimRef.current);
      lastFrame = performance.now();
      particleAnimRef.current = requestAnimationFrame(tick);
    };
    const onVisibility = () => {
      if (document.hidden) {
        cancelAnimationFrame(particleAnimRef.current);
      } else {
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      document.removeEventListener('visibilitychange', onVisibility);
      cancelAnimationFrame(particleAnimRef.current);
    };
  }, [nodes.length, settled]);

  // ---- Keyboard shortcuts ----
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
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
          fitToContentRef.current();
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
    const actual = newW / viewBox.width;
    const newH = viewBox.height * actual;
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

      const neighbors = new Set<string>();
      const adj = adjacency.get(nodeId);
      if (adj) adj.forEach((id) => neighbors.add(id));
      dragNeighborIds.current = neighbors;

      setNodes((prev) => prev.map((n) => (n.id === nodeId ? { ...n, pinned: true } : n)));

      const pullTick = () => {
        setNodes((prev) => {
          const draggedNode = prev.find((n) => n.id === nodeId);
          if (!draggedNode) return prev;

          const neighborNodes = prev.filter((n) => neighbors.has(n.id));

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

  // Ref so the keyboard handler (registered once with []) always calls the latest fitToContent.
  const fitToContentRef = useRef(fitToContent);
  fitToContentRef.current = fitToContent;

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

  const graphStats: GraphStats | null = useMemo(() => {
    if (nodes.length === 0) return null;
    const degreeMap: Record<string, number> = {};
    edges.forEach((e) => {
      degreeMap[e.source] = (degreeMap[e.source] || 0) + 1;
      degreeMap[e.target] = (degreeMap[e.target] || 0) + 1;
    });
    const degrees = Object.values(degreeMap);
    const maxDegree = Math.max(...degrees, 0);
    const avgDegree = degrees.length > 0 ? degrees.reduce((s, d) => s + d, 0) / degrees.length : 0;
    const hubNode = Object.entries(degreeMap).toSorted((a, b) => b[1] - a[1])[0];
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

  // Collect all present types (registered + unregistered) for the filter/legend UI
  const presentTypes = useMemo(() => {
    const types = new Set<string>();
    nodes.forEach((n) => types.add(n.type));
    return types;
  }, [nodes]);

  // ---- Error state ----
  if (error) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4">
        <div className="h-16 w-16 rounded-2xl bg-destructive/10 flex items-center justify-center">
          <Network className="h-8 w-8 text-destructive" />
        </div>
        <div className="text-center">
          <p className="text-sm font-medium text-destructive">{error}</p>
        </div>
      </div>
    );
  }

  // ---- Render ----
  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* ==================== TOOLBAR ==================== */}
      <GraphToolbar
        title={title}
        headerLeading={headerLeading}
        layoutMode={layoutMode}
        onLayoutModeChange={setLayoutMode}
        showFilters={showFilters}
        onToggleFilters={() => setShowFilters(!showFilters)}
        typeFilterCount={typeFilters.size}
        showClusters={showClusters}
        onToggleClusters={() => setShowClusters(!showClusters)}
        showMinimap={showMinimap}
        onToggleMinimap={() => setShowMinimap(!showMinimap)}
        showStats={showStats}
        onToggleStats={() => setShowStats(!showStats)}
        search={search}
        onSearchChange={setSearch}
        searchRef={searchRef}
      />

      {/* ==================== FILTER BAR ==================== */}
      {showFilters && (
        <GraphFilterBar
          presentTypes={presentTypes}
          typeCounts={typeCounts}
          typeFilters={typeFilters}
          onToggleTypeFilter={toggleTypeFilter}
          onClearAll={() => setTypeFilters(new Set())}
        />
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
                {loading ? 'Fetching artifacts and relationships...' : 'Settling node positions...'}
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
                Fetching artifacts and relationships...
              </p>
            </div>
          </div>
        ) : nodes.length === 0 ? (
          emptyState ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              {emptyState}
            </div>
          ) : (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
              <div className="h-20 w-20 rounded-2xl bg-muted/50 flex items-center justify-center">
                <Sparkles className="h-10 w-10 text-muted-foreground/40" />
              </div>
              <div className="text-center max-w-xs">
                <p className="text-sm font-semibold">No data yet</p>
                <p className="text-xs text-muted-foreground mt-1">
                  The knowledge graph will appear here once data is available.
                </p>
              </div>
            </div>
          )
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
                  {/* Gradient definitions for each present node type */}
                  {[...presentTypes].map((type) => {
                    const cfg = getNodeCfg(type);
                    return (
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
                    );
                  })}

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
                    const cfg = getNodeCfg(type);
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
                    const cfg = getNodeCfg(node.type);
                    const isSelected = selectedNode === node.id;
                    const isHovered = hoveredNode === node.id;
                    const isConnected = connectedNodeIds.has(node.id);
                    const dimmed = highlightNodeId && !isConnected;
                    const IconComp = cfg.icon;

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
                        {isSelected && (
                          <rect
                            x={-NODE_W / 2 - 5}
                            y={-NODE_H / 2 - 5}
                            width={NODE_W + 10}
                            height={NODE_H + 10}
                            rx={NODE_RX + 3}
                            fill="none"
                            stroke={cfg.color}
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

                        {isHovered && !isSelected && (
                          <rect
                            x={-NODE_W / 2 - 3}
                            y={-NODE_H / 2 - 3}
                            width={NODE_W + 6}
                            height={NODE_H + 6}
                            rx={NODE_RX + 2}
                            fill="none"
                            stroke={cfg.color}
                            strokeWidth={1.5}
                            opacity={0.4}
                          />
                        )}

                        <rect
                          x={-NODE_W / 2}
                          y={-NODE_H / 2}
                          width={NODE_W}
                          height={NODE_H}
                          rx={NODE_RX}
                          fill={`url(#grad-${node.type})`}
                        />

                        <rect
                          x={-NODE_W / 2 + 1}
                          y={-NODE_H / 2 + 1}
                          width={NODE_W - 2}
                          height={NODE_H / 2 - 1}
                          rx={NODE_RX - 1}
                          fill="white"
                          opacity={0.12}
                        />

                        <circle cx={-NODE_W / 2 + 20} cy={-6} r={13} fill="rgba(0,0,0,0.15)" />

                        <foreignObject
                          x={-NODE_W / 2 + 20 - ICON_SIZE / 2}
                          y={-6 - ICON_SIZE / 2}
                          width={ICON_SIZE}
                          height={ICON_SIZE}
                        >
                          <IconComp className="h-full w-full text-white/90" />
                        </foreignObject>

                        <text
                          x={-NODE_W / 2 + 20}
                          y={13}
                          textAnchor="middle"
                          fill={cfg.textColor}
                          fontSize={6.5}
                          fontWeight={700}
                          letterSpacing={0.6}
                          opacity={0.75}
                          style={{ textTransform: 'uppercase' }}
                        >
                          {cfg.shortLabel}
                        </text>

                        {(() => {
                          const [l1, l2] = splitLabelTwoLines(node.label || '');
                          if (l2 === null) {
                            return (
                              <text
                                x={6}
                                y={4}
                                textAnchor="middle"
                                fill={cfg.textColor}
                                fontSize={10}
                                fontWeight={500}
                              >
                                {l1}
                              </text>
                            );
                          }
                          return (
                            <>
                              <text
                                x={6}
                                y={-3}
                                textAnchor="middle"
                                fill={cfg.textColor}
                                fontSize={10}
                                fontWeight={500}
                              >
                                {l1}
                              </text>
                              <text
                                x={6}
                                y={9}
                                textAnchor="middle"
                                fill={cfg.textColor}
                                fontSize={10}
                                fontWeight={500}
                              >
                                {l2}
                              </text>
                            </>
                          );
                        })()}
                      </g>
                    );
                  })}
              </svg>

              {/* ===== Canvas Zoom Widget ===== */}
              <GraphZoomControls
                viewBox={viewBox}
                onViewBoxChange={setViewBox}
                onZoomIn={zoomIn}
                onZoomOut={zoomOut}
                onFitToContent={fitToContent}
              />

              {/* ===== Minimap ===== */}
              {showMinimap && minimapData && nodes.length > 3 && (
                <GraphMinimap
                  nodes={nodes}
                  filteredEdges={filteredEdges}
                  filteredNodeIds={filteredNodeIds}
                  nodeMap={nodeMap}
                  viewBox={viewBox}
                  selectedNode={selectedNode}
                  worldBox={minimapData.worldBox}
                />
              )}

              {/* ===== Legend (bottom-left) ===== */}
              {!loading && nodes.length > 0 && (
                <GraphLegend
                  presentTypes={presentTypes}
                  typeCounts={typeCounts}
                  typeFilters={typeFilters}
                  onToggleTypeFilter={toggleTypeFilter}
                />
              )}

              {/* ===== Statistics Panel (top-left) ===== */}
              {showStats && graphStats && (
                <GraphStatsPanel graphStats={graphStats} onClose={() => setShowStats(false)} />
              )}

              {/* ===== Keyboard shortcuts help ===== */}
              {showKeyboardHelp && <GraphKeyboardHelp onClose={() => setShowKeyboardHelp(false)} />}
            </>
          )
        )}

        {/* ==================== DETAIL PANEL ==================== */}
        {selectedNodeData && (
          <GraphNodePanel
            selectedNodeData={selectedNodeData}
            edges={edges}
            nodeMap={nodeMap}
            selectedNode={selectedNode!}
            onSelectNode={setSelectedNode}
          />
        )}
      </div>
    </div>
  );
}
