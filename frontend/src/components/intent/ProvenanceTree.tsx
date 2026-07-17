import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronRight, FileText, GitPullRequest, Layers, Package } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { IntentArtifact, IntentDetail, IntentGraphNode } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { ArtifactHistoryDrawer } from '@/components/intent/ArtifactHistoryDrawer';
import { IntentGraphPopover } from '@/components/intent/IntentGraphPopover';
import { DerivedItemCountChip } from '@/components/intent/DerivedItemCountChip';
import { type CodeItem } from '@/components/intent/CodeSection';
import {
  isDocumentArtifact,
  stripDocSuffix,
  detectDocCommonSuffix,
  docProvenance,
  type DocProvenance,
} from '@/components/intent/documentHelpers';
import { AlertTriangle } from 'lucide-react';
import { getTimeAgo } from '@/lib/timeAgo';
import { nodeTypeTextColor, shortNodeType } from '@/components/graph/nodeStyles';
import {
  onWorkProductFocus,
  scrollAndFlash,
  type WorkProductFocus,
} from '@/components/intent/workProductsFocus';

interface ProvenanceTreeProps {
  detail: IntentDetail;
  stageRows: IntentStageRow[];
  phaseNameOf: (phasePath: string) => string;
  getNeighbors: (id: string) => GraphNeighbor[];
  itemsByArtifact: Map<string, IntentGraphNode[]>;
  derivedItems: IntentGraphNode[];
  codeItems: CodeItem[];
  openArtifactPreview: (id: string) => void;
  openItemPreview: (id: string) => void;
}

interface PhaseNode {
  phasePath: string;
  phaseLabel: string;
  stages: StageNode[];
}

interface StageNode {
  stageId: string;
  stageLabel: string;
  unitSlug: string | null;
  documents: IntentArtifact[];
  order: number;
}

const HIDDEN_ITEM_TYPES = new Set(['StoryMapEntry']);

export function ProvenanceTree({
  detail,
  stageRows,
  phaseNameOf,
  getNeighbors,
  itemsByArtifact,
  derivedItems,
  codeItems,
  openArtifactPreview,
  openItemPreview,
}: ProvenanceTreeProps) {
  const activeArtifacts = detail.artifacts.filter((a) => !a.supersededAt);
  const documents = activeArtifacts.filter(isDocumentArtifact);

  const documentIdSet = useMemo(() => new Set(documents.map((d) => d.id)), [documents]);

  const commonSuffix = useMemo(
    () => detectDocCommonSuffix(documents.map((a) => a.title ?? '')),
    [documents],
  );

  const getProvenance = useMemo(
    () => docProvenance(stageRows, phaseNameOf),
    [stageRows, phaseNameOf],
  );

  const tree = useMemo(() => buildPhaseTree(documents, getProvenance), [documents, getProvenance]);

  // Derived items keep the standardized graph node palette (nodeStyles).
  const itemTypeLegend = useMemo(() => {
    const types = new Set<string>();
    for (const item of derivedItems) {
      if (!HIDDEN_ITEM_TYPES.has(item.type)) types.add(item.type);
    }
    return [...types].toSorted();
  }, [derivedItems]);

  // Unlinked: artifactId absent OR points to a non-rendered-document artifact.
  const unlinkedItems = useMemo(
    () =>
      derivedItems.filter(
        (i) =>
          !HIDDEN_ITEM_TYPES.has(i.type) && (!i.artifactId || !documentIdSet.has(i.artifactId)),
      ),
    [derivedItems, documentIdSet],
  );

  // Inverted expansion state: phases and stages render expanded by default
  // (newly streamed ones included) — users opt OUT per branch. Docs' item
  // lists stay opt-in.
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [collapsedStages, setCollapsedStages] = useState<Set<string>>(new Set());
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [otherItemsExpanded, setOtherItemsExpanded] = useState(false);

  const togglePhase = (path: string) =>
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const toggleStage = (stageKey: string) =>
    setCollapsedStages((prev) => {
      const next = new Set(prev);
      if (next.has(stageKey)) next.delete(stageKey);
      else next.add(stageKey);
      return next;
    });

  const toggleDoc = (docId: string) =>
    setExpandedDocs((prev) => {
      const next = new Set(prev);
      if (next.has(docId)) next.delete(docId);
      else next.add(docId);
      return next;
    });

  const expandToArtifact = useCallback(
    (artifactId: string) => {
      const doc = documents.find((d) => d.id === artifactId);
      if (!doc) return;
      const prov = getProvenance(doc);
      const phasePath = prov.phasePath || '__other__';
      setCollapsedPhases((p) => {
        if (!p.has(phasePath)) return p;
        const next = new Set(p);
        next.delete(phasePath);
        return next;
      });
      const stageKey = `${prov.phasePath}/${prov.stageId ?? '__none__'}/${prov.unitSlug ?? '__common__'}`;
      setCollapsedStages((p) => {
        if (!p.has(stageKey)) return p;
        const next = new Set(p);
        next.delete(stageKey);
        return next;
      });
    },
    [documents, getProvenance],
  );

  const expandToItem = useCallback(
    (itemId: string, filterArtifactId?: string) => {
      const item = itemId ? derivedItems.find((i) => i.id === itemId) : null;
      const targetArtifactId = item?.artifactId ?? filterArtifactId ?? null;

      if (targetArtifactId && documentIdSet.has(targetArtifactId)) {
        expandToArtifact(targetArtifactId);
        setExpandedDocs((p) => new Set([...p, targetArtifactId]));
      } else {
        setOtherItemsExpanded(true);
      }
    },
    [derivedItems, expandToArtifact, documentIdSet],
  );

  // The focus handler closes over per-render state; subscribe to the bus once
  // and route through a ref so streaming artifact updates never leave a
  // listener-less gap between unsubscribe and resubscribe.
  const focusHandlerRef = useRef<(focus: WorkProductFocus) => void>(() => {});
  useEffect(() => {
    focusHandlerRef.current = (focus: WorkProductFocus) => {
      if (focus.kind === 'artifact') {
        expandToArtifact(focus.id);
        scrollAndFlash(`artifact-${focus.id}`);
        openArtifactPreview(focus.id);
        return;
      }
      // DerivedItemCountChip sends {kind:'item', id:'', filterArtifactId}
      if (!focus.id && focus.filterArtifactId) {
        expandToArtifact(focus.filterArtifactId);
        setExpandedDocs((p) => new Set([...p, focus.filterArtifactId!]));
        scrollAndFlash(`artifact-${focus.filterArtifactId}`);
        return;
      }
      expandToItem(focus.id, focus.filterArtifactId);
      scrollAndFlash(focus.id ? `item-${focus.id}` : 'provenance-other-items');
    };
  }, [expandToArtifact, expandToItem, openArtifactPreview]);

  useEffect(() => onWorkProductFocus((focus) => focusHandlerRef.current(focus)), []);

  if (tree.length === 0 && codeItems.length === 0 && unlinkedItems.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1" role="tree" aria-label="Work products">
      {tree.map((phase) => (
        <TreeBranch
          key={phase.phasePath}
          icon={<Package className="h-3.5 w-3.5 text-muted-foreground" />}
          label={phase.phaseLabel}
          count={phase.stages.reduce((s, st) => s + st.documents.length, 0)}
          expanded={!collapsedPhases.has(phase.phasePath)}
          onToggle={() => togglePhase(phase.phasePath)}
          id={`provenance-phase-${phase.phasePath}`}
        >
          <div className="space-y-0.5 pl-5">
            {phase.stages.map((stage) => {
              const stageKey = `${phase.phasePath}/${stage.stageId}/${stage.unitSlug ?? '__common__'}`;
              return (
                <TreeBranch
                  key={stageKey}
                  icon={<Layers className="h-3 w-3 text-muted-foreground" />}
                  label={stage.stageLabel}
                  count={stage.documents.length}
                  expanded={!collapsedStages.has(stageKey)}
                  onToggle={() => toggleStage(stageKey)}
                  id={`provenance-stage-${stageKey}`}
                  compact
                  unitSlug={stage.unitSlug}
                >
                  <div className="space-y-0.5 pl-5">
                    {stage.documents.map((doc) => {
                      const docItems = itemsByArtifact.get(doc.id) ?? [];
                      const visibleItems = docItems.filter((i) => !HIDDEN_ITEM_TYPES.has(i.type));
                      const hasItems = visibleItems.length > 0;
                      const isExpanded = expandedDocs.has(doc.id);

                      return (
                        <Fragment key={doc.id}>
                          <DocumentRow
                            doc={doc}
                            commonSuffix={commonSuffix}
                            getNeighbors={getNeighbors}
                            itemCount={visibleItems.length}
                            hasItems={hasItems}
                            expanded={isExpanded}
                            onToggle={() => toggleDoc(doc.id)}
                            onPreview={() => openArtifactPreview(doc.id)}
                          />
                          {isExpanded && hasItems && (
                            <div className="space-y-0.5 pl-5">
                              {visibleItems.map((item) => (
                                <ItemRow
                                  key={item.id}
                                  item={item}
                                  getNeighbors={getNeighbors}
                                  onPreview={() => openItemPreview(item.id)}
                                />
                              ))}
                            </div>
                          )}
                        </Fragment>
                      );
                    })}
                  </div>
                </TreeBranch>
              );
            })}
          </div>
        </TreeBranch>
      ))}

      {/* Code renders after the phases — in workflow order it is the final
          output of construction, not the first thing produced. */}
      {codeItems.length > 0 && (
        <TreeBranch
          icon={<GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />}
          label="Code"
          count={codeItems.length}
          expanded={codeExpanded}
          onToggle={() => setCodeExpanded(!codeExpanded)}
          id="provenance-code"
        >
          <div className="space-y-1 pl-5">
            {codeItems.map((item) => (
              <CodeItemRow key={item.repo} item={item} />
            ))}
          </div>
        </TreeBranch>
      )}

      {unlinkedItems.length > 0 && (
        <TreeBranch
          icon={<Layers className="h-3.5 w-3.5 text-muted-foreground" />}
          label="Other items"
          count={unlinkedItems.length}
          expanded={otherItemsExpanded}
          onToggle={() => setOtherItemsExpanded(!otherItemsExpanded)}
          id="provenance-other-items"
        >
          <div className="space-y-0.5 pl-5">
            {unlinkedItems.map((item) => (
              <ItemRow
                key={item.id}
                item={item}
                getNeighbors={getNeighbors}
                onPreview={() => openItemPreview(item.id)}
              />
            ))}
          </div>
        </TreeBranch>
      )}

      {/* Legend for the item chevron colors — only types present, ≥2 (a
          single-entry legend is noise). */}
      {itemTypeLegend.length > 1 && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-2 pt-2">
          {itemTypeLegend.map((t) => (
            <span
              key={t}
              className="inline-flex items-center gap-1 text-[10px] text-muted-foreground/80"
            >
              <ChevronRight className={cn('h-3 w-3', nodeTypeTextColor(t))} strokeWidth={3} />
              {shortNodeType(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function TreeBranch({
  icon,
  label,
  count,
  expanded,
  onToggle,
  children,
  id,
  compact,
  unitSlug,
}: {
  icon: React.ReactNode;
  label: string;
  count: number;
  expanded: boolean;
  onToggle: () => void;
  children: React.ReactNode;
  id?: string;
  compact?: boolean;
  unitSlug?: string | null;
}) {
  return (
    <div id={id} role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className={cn(
          'flex w-full items-center gap-1.5 rounded-md px-2 text-left transition-colors hover:bg-muted/50',
          compact ? 'py-1' : 'py-1.5',
        )}
        onClick={onToggle}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        {icon}
        <span className={cn('text-sm font-medium', compact && 'text-xs')}>{label}</span>
        {unitSlug && (
          <Badge
            variant="outline"
            className="h-4 px-1 text-[9px] font-normal text-muted-foreground"
          >
            {unitSlug}
          </Badge>
        )}
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
          {count}
        </Badge>
      </button>
      {expanded && <div role="group">{children}</div>}
    </div>
  );
}

function DocumentRow({
  doc,
  commonSuffix,
  getNeighbors,
  itemCount,
  hasItems,
  expanded,
  onToggle,
  onPreview,
}: {
  doc: IntentArtifact;
  commonSuffix: string | null;
  getNeighbors: (id: string) => GraphNeighbor[];
  itemCount: number;
  hasItems: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  return (
    <div
      id={`artifact-${doc.id}`}
      className="group/doc flex items-center gap-1.5 rounded-md px-2 py-1 scroll-mt-4 hover:bg-muted/50 transition-colors"
    >
      {hasItems ? (
        <button
          type="button"
          onClick={onToggle}
          className="shrink-0 p-0.5"
          aria-expanded={expanded}
          aria-label={`Expand items for ${doc.title || doc.id}`}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
      ) : (
        <span className="w-4 shrink-0" />
      )}
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
        onClick={onPreview}
      >
        {doc.title ? stripDocSuffix(doc.title, commonSuffix) : doc.id}
      </button>
      {doc.staleSince && (
        <AlertTriangle
          aria-label="Possibly stale"
          className="h-3 w-3 shrink-0 text-agent-waiting"
        />
      )}
      {doc.createdAt && (
        <span className="shrink-0 text-[11px] text-muted-foreground/60">
          {getTimeAgo(doc.createdAt)}
        </span>
      )}
      <DerivedItemCountChip artifactId={doc.id} count={itemCount} />
      <ArtifactHistoryDrawer artifact={doc} />
      <IntentGraphPopover neighbors={getNeighbors(doc.id)} className="shrink-0" />
      <DiscussButton entityType="artifact" entityId={doc.id} entityTitle={doc.title || doc.id} />
    </div>
  );
}

function ItemRow({
  item,
  getNeighbors,
  onPreview,
}: {
  item: IntentGraphNode;
  getNeighbors: (id: string) => GraphNeighbor[];
  onPreview: () => void;
}) {
  return (
    <div
      id={`item-${item.id}`}
      role="button"
      tabIndex={0}
      className="group/item flex items-center gap-1.5 rounded-md px-2 py-1 scroll-mt-4 cursor-pointer hover:bg-muted/50 transition-colors"
      onClick={onPreview}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onPreview();
        }
      }}
    >
      <ChevronRight
        className={cn('h-3 w-3 shrink-0', nodeTypeTextColor(item.type))}
        strokeWidth={3}
      />
      <span className="min-w-0 flex-1 truncate text-sm">{item.label}</span>
      {item.priority && (
        <Badge variant="secondary" className="h-4 px-1 text-[9px] shrink-0">
          {item.priority}
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
  );
}

function CodeItemRow({ item }: { item: CodeItem }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{item.repo || 'Repository'}</span>
          {item.prNumber && <span className="text-muted-foreground">PR #{item.prNumber}</span>}
        </div>
        {item.branch && (
          <p className="flex items-center gap-1.5 truncate text-xs text-muted-foreground">
            <GitPullRequest className="h-3 w-3 shrink-0" />
            {item.branchUrl ? (
              <a
                href={item.branchUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="font-mono text-primary hover:underline underline-offset-2"
              >
                {item.branch}
              </a>
            ) : (
              <code className="font-mono">{item.branch}</code>
            )}
            {item.baseBranch && (
              <>
                {' → '}
                <code className="font-mono">{item.baseBranch}</code>
              </>
            )}
          </p>
        )}
      </div>
      {item.prUrl && (
        <a
          href={item.prUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="shrink-0 text-xs text-primary hover:underline"
        >
          Open PR
        </a>
      )}
    </div>
  );
}

const artifactTs = (a: IntentArtifact) => (a.createdAt ? new Date(a.createdAt).getTime() : 0);

function buildPhaseTree(
  documents: IntentArtifact[],
  getProvenance: (a: IntentArtifact) => DocProvenance,
): PhaseNode[] {
  const phases = new Map<string, PhaseNode>();
  const stageNodeMap = new Map<string, StageNode>();

  for (const doc of documents) {
    const prov = getProvenance(doc);
    const phasePath = prov.phasePath || '__other__';
    const phaseLabel = prov.phaseLabel || 'Other';

    if (!phases.has(phasePath)) {
      phases.set(phasePath, { phasePath, phaseLabel, stages: [] });
    }

    const stageKey = `${phasePath}/${prov.stageId ?? '__none__'}/${prov.unitSlug ?? '__common__'}`;
    let stageNode = stageNodeMap.get(stageKey);
    if (!stageNode) {
      stageNode = {
        stageId: prov.stageId ?? '__none__',
        stageLabel: prov.stageLabel ?? 'General',
        unitSlug: prov.unitSlug,
        documents: [],
        order: prov.stageOrder,
      };
      stageNodeMap.set(stageKey, stageNode);
      phases.get(phasePath)!.stages.push(stageNode);
    }
    stageNode.documents.push(doc);
  }

  for (const phase of phases.values()) {
    phase.stages.sort((a, b) => {
      if (a.order !== b.order) return a.order - b.order;
      // Same order (same stage, different units): tie-break with unitSlug for determinism.
      return codepointCompare(a.unitSlug ?? '', b.unitSlug ?? '');
    });
    for (const stage of phase.stages) {
      stage.documents.sort((a, b) => artifactTs(a) - artifactTs(b));
    }
  }

  // Sort phases in workflow (AIDLC) order — earliest path first, __other__
  // always last. Codepoint comparison (not localeCompare) so '01' vs '10'
  // ordering never depends on the browser locale's collation rules.
  return [...phases.values()].toSorted((a, b) => {
    if (a.phasePath === '__other__') return 1;
    if (b.phasePath === '__other__') return -1;
    return codepointCompare(a.phasePath, b.phasePath);
  });
}

function codepointCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
