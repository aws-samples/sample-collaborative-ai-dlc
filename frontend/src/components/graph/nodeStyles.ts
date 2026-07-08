// Shared v2 node/edge presentation vocabulary for the LIGHT graph surfaces
// (the graph-context popover and the derived-items list on the intent
// workbench). The full GraphCanvas keeps its own richer NODE_TYPES config —
// this map covers only what badges/labels outside the canvas need, so the two
// stay decoupled (changing a canvas color scheme never restyles the cards).

// Badge classes per vertex label (v2 intent graph vocabulary incl. the
// derived layer). Falls back to a muted badge for unknown labels.
export const NODE_TYPE_BADGES: Record<string, string> = {
  Intent: 'bg-red-500/15 text-red-600 border-red-500/30',
  Artifact: 'bg-cyan-500/15 text-cyan-600 border-cyan-500/30',
  Question: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  Steering: 'bg-rose-500/15 text-rose-600 border-rose-500/30',
  Discussion: 'bg-blue-500/15 text-blue-600 border-blue-500/30',
  TeamKnowledge: 'bg-fuchsia-500/15 text-fuchsia-600 border-fuchsia-500/30',
  LearningRule: 'bg-pink-500/15 text-pink-600 border-pink-500/30',
  // Derived layer (matches the GraphCanvas hues for recognition).
  Story: 'bg-green-500/15 text-green-600 border-green-500/30',
  Persona: 'bg-violet-500/15 text-violet-600 border-violet-500/30',
  Requirement: 'bg-orange-500/15 text-orange-600 border-orange-500/30',
  Component: 'bg-sky-500/15 text-sky-600 border-sky-500/30',
  Decision: 'bg-yellow-500/15 text-yellow-700 border-yellow-500/30',
  StoryMapEntry: 'bg-teal-500/15 text-teal-600 border-teal-500/30',
  Contract: 'bg-indigo-500/15 text-indigo-600 border-indigo-500/30',
  UnitOfWork: 'bg-amber-500/15 text-amber-600 border-amber-500/30',
};

export const nodeTypeBadge = (type: string): string =>
  NODE_TYPE_BADGES[type] ?? 'bg-muted text-muted-foreground';

// Compact display names for narrow badges.
const SHORT_TYPES: Record<string, string> = {
  StoryMapEntry: 'Map',
  UnitOfWork: 'Unit',
  TeamKnowledge: 'Knowledge',
  LearningRule: 'Rule',
};

export const shortNodeType = (type: string): string => SHORT_TYPES[type] ?? type;

// Humanized edge labels — the v2 intent-graph vocabulary (business edges,
// the derived projection, and the item↔item traceability edges the derive
// sweep materializes; see docs/v2-granular-graph.md).
export const EDGE_LABELS: Record<string, string> = {
  CONTAINS: 'contains',
  PRODUCES: 'produces',
  CONSUMES: 'consumes',
  DERIVED_FROM: 'derived from',
  RELATES_TO: 'relates to',
  DEPENDS_ON: 'depends on',
  INFLUENCES: 'influences',
  DISCUSSES: 'discusses',
  INFORMS: 'informs',
  REVISES: 'revises',
  CITES: 'cites',
  HAS_SECTION: 'has section',
  HAS_ITEM: 'has item',
  COVERS: 'covers',
  FOR_PERSONA: 'for persona',
  IMPLEMENTS: 'implements',
  EXPOSES: 'exposes',
  CONSUMES_CONTRACT: 'consumes contract',
};

export const humanEdgeLabel = (label: string): string =>
  EDGE_LABELS[label] ?? label.replace(/_/g, ' ').toLowerCase();
