// Shared accent palette for v2 artifact types. The vocabulary is workflow-
// defined (open-ended), so types hash onto a stable small palette instead of a
// maintained map — the same artifact type always gets the same accent across
// the artifact cards and the knowledge graph.

export interface ArtifactAccent {
  /** Left-border accent for the artifact card. */
  borderL: string;
  /** Full-border accent for graph node chips. */
  border: string;
  /** Solid dot / swatch. */
  dot: string;
}

export const ACCENTS: ArtifactAccent[] = [
  { borderL: 'border-l-orange-500', border: 'border-orange-500/50', dot: 'bg-orange-500' },
  { borderL: 'border-l-green-500', border: 'border-green-500/50', dot: 'bg-green-500' },
  { borderL: 'border-l-sky-500', border: 'border-sky-500/50', dot: 'bg-sky-500' },
  { borderL: 'border-l-purple-500', border: 'border-purple-500/50', dot: 'bg-purple-500' },
  { borderL: 'border-l-amber-500', border: 'border-amber-500/50', dot: 'bg-amber-500' },
  { borderL: 'border-l-teal-500', border: 'border-teal-500/50', dot: 'bg-teal-500' },
  { borderL: 'border-l-rose-500', border: 'border-rose-500/50', dot: 'bg-rose-500' },
];

const FALLBACK: ArtifactAccent = {
  borderL: 'border-l-muted-foreground/40',
  border: 'border-border',
  dot: 'bg-muted-foreground',
};

export function artifactAccent(type: string | null | undefined): ArtifactAccent {
  if (!type) return FALLBACK;
  let h = 0;
  for (let i = 0; i < type.length; i++) h = (h * 31 + type.charCodeAt(i)) >>> 0;
  return ACCENTS[h % ACCENTS.length];
}
