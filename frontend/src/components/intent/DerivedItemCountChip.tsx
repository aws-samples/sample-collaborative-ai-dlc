import { cn } from '@/lib/utils';
import { Layers } from 'lucide-react';
import { focusWorkProduct } from '@/components/intent/workProductsFocus';

// Per-artifact "N items" chip: shows how many granular typed items the derive
// step mirrored out of this artifact, and jumps (in-page) to the artifact's
// expanded item rows in the provenance tree. Renders nothing when the artifact
// has no derived items.

interface DerivedItemCountChipProps {
  artifactId: string;
  count: number;
  className?: string;
}

export function DerivedItemCountChip({ artifactId, count, className }: DerivedItemCountChipProps) {
  if (count === 0) return null;
  return (
    <button
      type="button"
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full border bg-secondary px-2',
        'text-2xs tabular-nums text-secondary-foreground hover:bg-secondary/70 transition-colors',
        className,
      )}
      aria-label={`Show ${count} item${count !== 1 ? 's' : ''} derived from this document`}
      title={`${count} item${count !== 1 ? 's' : ''} derived from this document — click to reveal`}
      onClick={(e) => {
        e.stopPropagation();
        focusWorkProduct({ kind: 'item', id: '', filterArtifactId: artifactId });
      }}
    >
      <Layers aria-hidden="true" className="h-3 w-3" />
      {count}
    </button>
  );
}
