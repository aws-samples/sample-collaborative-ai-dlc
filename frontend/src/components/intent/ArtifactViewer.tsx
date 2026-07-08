import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { useIntent } from '@/contexts/IntentContext';
import { artifactAccent } from '@/components/intent/artifactAccent';
import { IntentGraphPopover } from '@/components/intent/IntentGraphPopover';
import { DerivedItemCountChip } from '@/components/intent/DerivedItemCountChip';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import type { IntentArtifact } from '@/services/intents';
import { ChevronDown } from 'lucide-react';

// Read-only v2 artifact card, modeled on v1's ArtifactCard visual language
// (type-colored left border) but fed by the intent detail DTO. Artifacts are
// primary run output, so they stay in the main pane. `id` anchors the
// stage-detail "produced artifact" jump links and the graph popover's in-page
// navigation. `graphNeighbors`/`derivedItemCount` are supplied by the panel
// (one shared graph fetch) — both optional so the card renders standalone.

// Bodies beyond this many characters start collapsed behind a "Show more".
const COLLAPSE_CHARS = 1200;

export function ArtifactViewer({
  artifact,
  graphNeighbors = [],
  derivedItemCount = 0,
}: {
  artifact: IntentArtifact;
  graphNeighbors?: GraphNeighbor[];
  derivedItemCount?: number;
}) {
  const { detail, setSelectedStageId } = useIntent();
  const [expanded, setExpanded] = useState(false);

  const content = artifact.content ?? '';
  const collapsible = content.length > COLLAPSE_CHARS;
  const shown = collapsible && !expanded ? `${content.slice(0, COLLAPSE_CHARS)}…` : content;

  // Provenance: the stage that produced this artifact (jump link selects it in
  // the pipeline), plus the creation time.
  const producedBy = artifact.createdByStageInstanceId
    ? (detail?.stages.find((s) => s.stageInstanceId === artifact.createdByStageInstanceId) ?? null)
    : null;

  // Rewind lineage (docs/v2-steering.md): a superseded artifact came from a
  // rewound stage attempt; it is kept (dimmed) until the re-run rehabilitates
  // or replaces it.
  const superseded = Boolean(artifact.supersededAt);

  return (
    <Card
      id={`artifact-${artifact.id}`}
      className={cn(
        'border-l-[3px] scroll-mt-4',
        artifactAccent(artifact.artifactType).borderL,
        superseded && 'opacity-60',
      )}
    >
      <CardContent className="p-3">
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {artifact.artifactType && (
                <span className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground/60">
                  {artifact.artifactType}
                </span>
              )}
              <h4 className="min-w-0 truncate text-sm font-medium">
                {artifact.title || artifact.id}
              </h4>
              {superseded && (
                <Badge
                  variant="outline"
                  className="bg-muted px-1.5 py-0 text-[10px] text-muted-foreground"
                  title="Superseded by a rewind — the re-run will update or replace it"
                >
                  superseded
                </Badge>
              )}
            </div>
            <p className="mt-0.5 text-[11px] text-muted-foreground">
              {producedBy?.stageId ? (
                <>
                  produced by{' '}
                  <button
                    type="button"
                    className="font-medium underline-offset-2 hover:underline"
                    onClick={() => {
                      setSelectedStageId(producedBy.stageId);
                      document
                        .getElementById('intent-stages')
                        ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                    }}
                  >
                    {producedBy.stageId}
                  </button>
                </>
              ) : (
                'produced by this run'
              )}
              {artifact.createdAt && <> · {new Date(artifact.createdAt).toLocaleString()}</>}
            </p>
          </div>
          <DerivedItemCountChip artifactId={artifact.id} count={derivedItemCount} />
          <IntentGraphPopover neighbors={graphNeighbors} className="shrink-0" />
          <DiscussButton
            entityType="artifact"
            entityId={artifact.id}
            entityTitle={artifact.title || artifact.id}
            className="shrink-0"
          />
        </div>

        {content && (
          <div className="prose prose-sm dark:prose-invert mt-2 max-w-none">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{shown}</ReactMarkdown>
          </div>
        )}
        {collapsible && (
          <Button
            size="sm"
            variant="ghost"
            className="mt-1 h-6 gap-1 px-2 text-[11px] text-muted-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            <ChevronDown className={cn('h-3 w-3 transition-transform', expanded && 'rotate-180')} />
            {expanded ? 'Show less' : 'Show more'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
