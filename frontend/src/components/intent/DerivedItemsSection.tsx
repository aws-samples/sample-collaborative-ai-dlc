import { Fragment } from 'react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Layers, X } from 'lucide-react';
import type { IntentGraphNode } from '@/services/intents';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import { IntentGraphPopover } from '@/components/intent/IntentGraphPopover';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { nodeTypeBadge } from '@/components/graph/nodeStyles';

// The "Derived items" accordion group on the intent workbench: the granular
// typed items (Story/Requirement/Persona/…) the derive step mirrors out of
// artifact structured blocks (docs/v2-granular-graph.md), grouped by type.
// Rows are the in-page navigation TARGETS for the graph-context popover
// (anchor id `item-<nodeId>`), and each row carries its own popover so the
// traceability edges (covers / for persona / depends on / implements) can be
// walked without opening the graph page.

// Canonical display order; unknown types append alphabetically after these.
const TYPE_ORDER = [
  'Requirement',
  'Story',
  'Persona',
  'Component',
  'Decision',
  'StoryMapEntry',
  'Contract',
];

const TYPE_GROUP_LABELS: Record<string, string> = {
  Requirement: 'Requirements',
  Story: 'Stories',
  Persona: 'Personas',
  Component: 'Components',
  Decision: 'Decisions',
  StoryMapEntry: 'Story map',
  Contract: 'Contracts',
};

export const DERIVED_ITEMS_ACCORDION_VALUE = 'derived-items';
export const DERIVED_ITEMS_SECTION_ID = 'derived-items-section';

interface DerivedItemsSectionProps {
  items: IntentGraphNode[];
  getNeighbors: (id: string) => GraphNeighbor[];
  /** Open the item's detail card in the right panel's Preview tab. */
  openItemPreview: (id: string) => void;
  /** Transient source-artifact filter (set by the per-artifact items chip). */
  filterArtifactId: string | null;
  onClearFilter: () => void;
  /** Artifact titles for the filter pill. */
  artifactTitleById: Map<string, string>;
}

export function DerivedItemsSection({
  items,
  getNeighbors,
  openItemPreview,
  filterArtifactId,
  onClearFilter,
  artifactTitleById,
}: DerivedItemsSectionProps) {
  if (items.length === 0) return null;

  const visible = filterArtifactId ? items.filter((i) => i.artifactId === filterArtifactId) : items;

  // Group by item type in canonical order.
  const byType = new Map<string, IntentGraphNode[]>();
  for (const item of visible) {
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type)!.push(item);
  }
  const types = [...byType.keys()].toSorted((a, b) => {
    const ia = TYPE_ORDER.indexOf(a);
    const ib = TYPE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });

  const filterTitle = filterArtifactId
    ? (artifactTitleById.get(filterArtifactId) ?? filterArtifactId)
    : null;

  return (
    <AccordionItem
      value={DERIVED_ITEMS_ACCORDION_VALUE}
      className="rounded-md border px-3"
      id={DERIVED_ITEMS_SECTION_ID}
    >
      <AccordionTrigger className="py-3 hover:no-underline">
        <div className="flex items-center gap-2">
          <Layers className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Derived items</span>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {items.length}
          </Badge>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 pb-3">
        <p className="text-[11px] text-muted-foreground">
          Typed items the runtime derives from the artifacts' structured blocks — the granular layer
          of the knowledge graph.
        </p>
        {filterTitle && (
          <div className="flex items-center gap-1.5">
            <Badge variant="secondary" className="h-5 gap-1 pl-1.5 pr-0.5 text-[10px]">
              from: {filterTitle}
              <Button
                variant="ghost"
                size="icon"
                className="h-4 w-4"
                aria-label="Clear artifact filter"
                onClick={onClearFilter}
              >
                <X className="h-2.5 w-2.5" />
              </Button>
            </Badge>
            {visible.length === 0 && (
              <span className="text-[11px] text-muted-foreground">no items from this artifact</span>
            )}
          </div>
        )}
        {types.map((type) => (
          <Fragment key={type}>
            <div className="flex items-center gap-1.5 pt-1">
              <span className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground">
                {TYPE_GROUP_LABELS[type] ?? type}
              </span>
              <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                {byType.get(type)!.length}
              </Badge>
            </div>
            <div className="space-y-0.5">
              {byType
                .get(type)!
                .toSorted((a, b) => String(a.slug ?? a.id).localeCompare(String(b.slug ?? b.id)))
                .map((item) => (
                  <div
                    key={item.id}
                    id={`item-${item.id}`}
                    role="button"
                    tabIndex={0}
                    className="group/item flex cursor-pointer items-center gap-2 rounded-md px-2 py-1 scroll-mt-4 hover:bg-muted/50 transition-colors"
                    onClick={() => openItemPreview(item.id)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openItemPreview(item.id);
                      }
                    }}
                  >
                    <Badge
                      variant="outline"
                      className={cn('h-4 px-1 text-[8px] shrink-0', nodeTypeBadge(item.type))}
                    >
                      {item.slug ?? item.type}
                    </Badge>
                    <span className="min-w-0 flex-1 truncate text-sm" title={item.label}>
                      {item.label}
                    </span>
                    {item.priority && (
                      <Badge variant="secondary" className="h-4 px-1 text-[9px] shrink-0">
                        {item.priority}
                      </Badge>
                    )}
                    {item.status && (
                      <Badge variant="outline" className="h-4 px-1 text-[9px] shrink-0">
                        {item.status}
                      </Badge>
                    )}
                    <IntentGraphPopover neighbors={getNeighbors(item.id)} className="shrink-0" />
                    <DiscussButton
                      entityType="item"
                      entityId={item.id}
                      entityTitle={item.label}
                      className="shrink-0"
                    />
                  </div>
                ))}
            </div>
          </Fragment>
        ))}
      </AccordionContent>
    </AccordionItem>
  );
}
