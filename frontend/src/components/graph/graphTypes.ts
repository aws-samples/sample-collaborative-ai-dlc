import { type GraphNode } from '@/services/sprintGraph';
import {
  FileText,
  BookOpen,
  ListChecks,
  Code2,
  HelpCircle,
  ShieldCheck,
  Info,
  GitPullRequest,
  Bot,
  MessageSquare,
  Target,
  Layers,
  Compass,
  Brain,
  Lightbulb,
  CircleDot,
  User,
  Box,
  Scale,
  FileSignature,
  Package,
  Map as MapIcon,
} from 'lucide-react';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

export const NODE_TYPES: Record<
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
  // -- v2 intent-graph types --
  Intent: {
    color: '#f43f5e',
    darkColor: '#e11d48',
    gradientFrom: '#fb7185',
    gradientTo: '#e11d48',
    textColor: '#fff',
    icon: Target,
    label: 'Intent',
    shortLabel: 'Int',
  },
  Artifact: {
    color: '#06b6d4',
    darkColor: '#0891b2',
    gradientFrom: '#22d3ee',
    gradientTo: '#0891b2',
    textColor: '#fff',
    icon: Layers,
    label: 'Artifact',
    shortLabel: 'Art',
  },
  Steering: {
    color: '#d97706',
    darkColor: '#b45309',
    gradientFrom: '#fbbf24',
    gradientTo: '#b45309',
    textColor: '#fff',
    icon: Compass,
    label: 'Steering',
    shortLabel: 'Steer',
  },
  TeamKnowledge: {
    color: '#65a30d',
    darkColor: '#4d7c0f',
    gradientFrom: '#a3e635',
    gradientTo: '#4d7c0f',
    textColor: '#fff',
    icon: Brain,
    label: 'Team Knowledge',
    shortLabel: 'TK',
  },
  LearningRule: {
    color: '#ec4899',
    darkColor: '#db2777',
    gradientFrom: '#f472b6',
    gradientTo: '#db2777',
    textColor: '#fff',
    icon: Lightbulb,
    label: 'Learning Rule',
    shortLabel: 'Rule',
  },
  // -- v2 derived layer (typed items mirrored from artifact structured blocks
  //    + the unit-of-work DAG mirror; nodes carry graphLayer='derived') --
  Story: {
    color: '#22c55e',
    darkColor: '#16a34a',
    gradientFrom: '#4ade80',
    gradientTo: '#16a34a',
    textColor: '#fff',
    icon: BookOpen,
    label: 'Story',
    shortLabel: 'Story',
  },
  Persona: {
    color: '#8b5cf6',
    darkColor: '#7c3aed',
    gradientFrom: '#a78bfa',
    gradientTo: '#7c3aed',
    textColor: '#fff',
    icon: User,
    label: 'Persona',
    shortLabel: 'Pers',
  },
  Component: {
    color: '#0ea5e9',
    darkColor: '#0284c7',
    gradientFrom: '#38bdf8',
    gradientTo: '#0284c7',
    textColor: '#fff',
    icon: Box,
    label: 'Component',
    shortLabel: 'Comp',
  },
  Decision: {
    color: '#eab308',
    darkColor: '#ca8a04',
    gradientFrom: '#facc15',
    gradientTo: '#ca8a04',
    textColor: '#000',
    icon: Scale,
    label: 'Decision',
    shortLabel: 'Dec',
  },
  StoryMapEntry: {
    color: '#14b8a6',
    darkColor: '#0d9488',
    gradientFrom: '#2dd4bf',
    gradientTo: '#0d9488',
    textColor: '#fff',
    icon: MapIcon,
    label: 'Story Mapping',
    shortLabel: 'Map',
  },
  Contract: {
    color: '#6366f1',
    darkColor: '#4f46e5',
    gradientFrom: '#818cf8',
    gradientTo: '#4f46e5',
    textColor: '#fff',
    icon: FileSignature,
    label: 'Contract',
    shortLabel: 'Ctr',
  },
  UnitOfWork: {
    color: '#f59e0b',
    darkColor: '#d97706',
    gradientFrom: '#fbbf24',
    gradientTo: '#d97706',
    textColor: '#000',
    icon: Package,
    label: 'Unit of Work',
    shortLabel: 'Unit',
  },
  UnitPullRequest: {
    color: '#0891b2',
    darkColor: '#0e7490',
    gradientFrom: '#22d3ee',
    gradientTo: '#0e7490',
    textColor: '#fff',
    icon: GitPullRequest,
    label: 'Unit Pull Request',
    shortLabel: 'Unit PR',
  },
};

const UNKNOWN_NODE_CFG = {
  color: '#78716c',
  darkColor: '#57534e',
  gradientFrom: '#a8a29e',
  gradientTo: '#57534e',
  textColor: '#fff',
  icon: CircleDot,
  label: 'Unknown',
  shortLabel: '?',
} as const;

export function getNodeCfg(type: string) {
  return NODE_TYPES[type] ?? UNKNOWN_NODE_CFG;
}

export const EDGE_LABELS: Record<string, string> = {
  BREAKS_INTO: 'breaks into',
  IMPLEMENTED_BY: 'implemented by',
  DEPENDS_ON: 'depends on',
  REVIEWS: 'reviews',
  VALIDATES: 'validates',
  INFLUENCES: 'influences',
  RELATES_TO: 'relates to',
  CARRIED_FROM: 'carried from',
  DISCUSSES: 'discusses',
  CONTAINS: 'contains',
  PRODUCES: 'produces',
  CONSUMES: 'consumes',
  DERIVED_FROM: 'derived from',
  INFORMS: 'informs',
  HAS_ITEM: 'has item',
  CITES: 'cites',
};

export const NODE_W = 156;
export const NODE_H = 56;
export const NODE_RX = 12;
export const ICON_SIZE = 14;

export const TYPE_HIERARCHY: string[] = [
  'AgentRun',
  'Intent',
  'Requirement',
  'GeneralInfo',
  'Steering',
  'UserStory',
  'TeamKnowledge',
  'LearningRule',
  'Task',
  'Artifact',
  'UnitOfWork',
  'UnitPullRequest',
  'Story',
  'Persona',
  'Component',
  'Decision',
  'StoryMapEntry',
  'Contract',
  'CodeFile',
  'Review',
  'Question',
  'PullRequest',
  'Discussion',
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface LayoutNode extends GraphNode {
  x: number;
  y: number;
  vx: number;
  vy: number;
  pinned?: boolean;
}

export interface ViewBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type LayoutMode = 'force' | 'hierarchical';

// ---------------------------------------------------------------------------
// Utility: Convex hull (Andrew's monotone chain)
// ---------------------------------------------------------------------------

const cross = (
  O: { x: number; y: number },
  A: { x: number; y: number },
  B: { x: number; y: number },
) => (A.x - O.x) * (B.y - O.y) - (A.y - O.y) * (B.x - O.x);

function convexHull(points: { x: number; y: number }[]): { x: number; y: number }[] {
  if (points.length < 3) return points;
  const pts = [...points].toSorted((a, b) => a.x - b.x || a.y - b.y);

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

export function hullPath(nodes: LayoutNode[], padding: number): string {
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

export function deriveNodeLabel(node: GraphNode): string {
  if (node.label && node.label !== '(unnamed)') return node.label;

  switch (node.type) {
    case 'Question': {
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
    case 'UnitPullRequest':
    case 'PullRequest': {
      const num = node.pr_number;
      if (num) return node.type === 'UnitPullRequest' ? `Unit PR #${num}` : `PR #${num}`;
      return node.type === 'UnitPullRequest' ? 'Unit Pull Request' : 'Pull Request';
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
// Utility: two-line word-aware label wrapping
// ---------------------------------------------------------------------------

export function splitLabelTwoLines(label: string): [string, string | null] {
  if (!label) return ['', null];
  if (label.length <= 17) return [label, null];
  const breakIdx = label.lastIndexOf(' ', 17);
  const line1 = breakIdx > 0 ? label.slice(0, breakIdx) : label.slice(0, 17);
  const rest = breakIdx > 0 ? label.slice(breakIdx + 1) : label.slice(17);
  if (!rest) return [line1, null];
  const line2 = rest.length > 17 ? rest.slice(0, 15) + '...' : rest;
  return [line1, line2];
}

// ---------------------------------------------------------------------------
// Zoom log-scale helpers: t ∈ [0,1] → width = 12000*(300/12000)^t
// ---------------------------------------------------------------------------

export const ZOOM_MIN_W = 300;
export const ZOOM_MAX_W = 12000;
const ZOOM_LOG_RATIO = Math.log(ZOOM_MIN_W / ZOOM_MAX_W);

export function widthToSliderT(w: number): number {
  return Math.log(w / ZOOM_MAX_W) / ZOOM_LOG_RATIO;
}

export function sliderTToWidth(t: number): number {
  return ZOOM_MAX_W * Math.pow(ZOOM_MIN_W / ZOOM_MAX_W, t);
}
