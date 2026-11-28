import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  GitPullRequest,
  Layers,
  Package,
  Search,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';
import { displayStageName, humanizeSlug } from '@/lib/displayNames';
import type { IntentArtifact, IntentDetail, IntentGraphNode } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { ArtifactHistoryDrawer } from '@/components/intent/ArtifactHistoryDrawer';
import { IntentGraphPopover } from '@/components/intent/IntentGraphPopover';
import { type CodeItem, type UnitBranchItem } from '@/components/intent/CodeSection';
import { GitProviderIcon } from '@/components/icons/git-providers';
import { UnitBranchEntry } from '@/components/intent/UnitBranchEntry';
import {
  isDocumentArtifact,
  stripDocSuffix,
  detectDocCommonSuffix,
  docProvenance,
  type DocProvenance,
} from '@/components/intent/documentHelpers';
import { AlertTriangle } from 'lucide-react';
import { nodeTypeTextColor, shortNodeType } from '@/components/graph/nodeStyles';
import { DerivedItemRow } from '@/components/intent/DerivedItemRow';
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
  unitBranchItems: UnitBranchItem[];
  openArtifactPreview: (id: string) => void;
  openItemPreview: (id: string) => void;
  documentOrder?: 'oldest-first' | 'newest-first';
  /** Case-insensitive text matched against document titles and stage names. */
  filter?: string;
}

interface PhaseNode {
  phasePath: string;
  phaseLabel: string;
  stages: StageNode[];
}

interface StageNode {
  key: string;
  stageId: string;
  stageLabel: string;
  unitSlug: string | null;
  sectionIndex: number | null;
  documents: IntentArtifact[];
  order: number;
  active: boolean;
  latestCreatedAt: string | null;
}

const HIDDEN_ITEM_TYPES = new Set(['StoryMapEntry']);
const plural = (n: number, noun: string) => `${n} ${noun}${n === 1 ? '' : 's'}`;
const ACTIVE_STAGE_STATES = new Set(['RUNNING', 'WAITING_FOR_HUMAN']);

function stageBranchKey(
  phasePath: string,
  stageId: string | null | undefined,
  unitSlug: string | null | undefined,
  sectionIndex: number | null | undefined,
): string {
  const laneKey =
    unitSlug && sectionIndex != null ? `s${sectionIndex}:${unitSlug}` : (unitSlug ?? '__common__');
  return `${phasePath || '__other__'}/${stageId ?? '__none__'}/${laneKey}`;
}

function documentLabel(doc: IntentArtifact, commonSuffix: string | null = null): string {
  if (doc.title) return stripDocSuffix(doc.title, commonSuffix);
  if (doc.artifactType) return humanizeSlug(doc.artifactType);
  return 'Untitled document';
}

export function ProvenanceTree({
  detail,
  stageRows,
  phaseNameOf,
  getNeighbors,
  itemsByArtifact,
  derivedItems,
  codeItems,
  unitBranchItems,
  openArtifactPreview,
  openItemPreview,
  documentOrder = 'oldest-first',
  filter = '',
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

  const tree = useMemo(
    () => buildPhaseTree(documents, getProvenance, stageRows, documentOrder),
    [documents, getProvenance, stageRows, documentOrder],
  );

  const query = filter.trim().toLowerCase();
  const filtering = query.length > 0;

  const visibleTree = useMemo(
    () => (filtering ? filterPhaseTree(tree, query, commonSuffix) : tree),
    [tree, filtering, query, commonSuffix],
  );

  const defaultOpenStageKey = useMemo(() => pickDefaultOpenStage(tree), [tree]);

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

  // A tree: phases hold stages, stages hold documents. Phases are open; stages
  // follow the computed default (current stage, or the newest work) until the
  // user toggles one. A text filter resets those choices so every match shows.
  const [collapsedPhases, setCollapsedPhases] = useState<Set<string>>(new Set());
  const [stageOverrides, setStageOverrides] = useState<Map<string, boolean>>(new Map());
  const [expandedDocs, setExpandedDocs] = useState<Set<string>>(new Set());
  const [codeExpanded, setCodeExpanded] = useState(false);
  const [otherItemsExpanded, setOtherItemsExpanded] = useState(false);
  const lastQuery = useRef(query);
  if (lastQuery.current !== query) {
    lastQuery.current = query;
    if (stageOverrides.size > 0) setStageOverrides(new Map());
    if (collapsedPhases.size > 0) setCollapsedPhases(new Set());
  }

  const togglePhase = (phasePath: string) =>
    setCollapsedPhases((prev) => {
      const next = new Set(prev);
      if (next.has(phasePath)) next.delete(phasePath);
      else next.add(phasePath);
      return next;
    });

  const isStageOpen = (stageKey: string) =>
    stageOverrides.get(stageKey) ?? (filtering || stageKey === defaultOpenStageKey);

  const setStageOpen = (stageKey: string, open: boolean) =>
    setStageOverrides((prev) => new Map(prev).set(stageKey, open));

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
      setCollapsedPhases((prev) => {
        if (!prev.has(phasePath)) return prev;
        const next = new Set(prev);
        next.delete(phasePath);
        return next;
      });
      const stageKey = stageBranchKey(phasePath, prov.stageId, prov.unitSlug, prov.sectionIndex);
      setStageOverrides((prev) =>
        prev.get(stageKey) === true ? prev : new Map(prev).set(stageKey, true),
      );
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

  const codeBranch =
    codeItems.length > 0 && !filtering ? (
      <TreeBranch
        icon={<GitPullRequest className="h-3.5 w-3.5 text-muted-foreground" />}
        label="Code"
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
    ) : null;

  const hasMatch = visibleTree.some((phase) => phase.stages.length > 0);

  return (
    <div className="space-y-1" role="tree" aria-label="Work products">
      {filtering && !hasMatch && (
        <EmptyState
          size="section"
          icon={Search}
          title={`No documents match “${filter.trim()}”`}
          description="Try a shorter word, or a stage name such as “design”."
        />
      )}

      {documentOrder === 'newest-first' && codeBranch}

      {visibleTree.map((phase) => (
        <TreeBranch
          key={phase.phasePath}
          icon={<Package className="h-3.5 w-3.5 text-muted-foreground" />}
          label={phase.phaseLabel}
          folded={plural(
            phase.stages.reduce((sum, stage) => sum + stage.documents.length, 0),
            'document',
          )}
          expanded={!collapsedPhases.has(phase.phasePath)}
          onToggle={() => togglePhase(phase.phasePath)}
          id={`provenance-phase-${phase.phasePath}`}
        >
          <div className="space-y-0.5 pl-5">
            {phase.stages.map((stage) => (
              <StageBranch
                key={stage.key}
                stage={stage}
                open={isStageOpen(stage.key)}
                onOpenChange={(open) => setStageOpen(stage.key, open)}
                commonSuffix={commonSuffix}
                getNeighbors={getNeighbors}
                itemsByArtifact={itemsByArtifact}
                unitBranchItems={unitBranchItems}
                expandedDocs={expandedDocs}
                toggleDoc={toggleDoc}
                openArtifactPreview={openArtifactPreview}
                openItemPreview={openItemPreview}
              />
            ))}
          </div>
        </TreeBranch>
      ))}

      {documentOrder === 'oldest-first' && codeBranch}

      {unlinkedItems.length > 0 && !filtering && (
        <TreeBranch
          icon={<Layers className="h-3.5 w-3.5 text-muted-foreground" />}
          label="Other items"
          folded={plural(unlinkedItems.length, 'item')}
          expanded={otherItemsExpanded}
          onToggle={() => setOtherItemsExpanded(!otherItemsExpanded)}
          id="provenance-other-items"
        >
          <div className="space-y-0.5 pl-5">
            {unlinkedItems.map((item) => (
              <DerivedItemRow
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
      {itemTypeLegend.length > 1 && !filtering && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 border-t border-border/40 px-2 pt-2">
          {itemTypeLegend.map((t) => (
            <span key={t} className="inline-flex items-center gap-1 text-2xs text-muted-foreground">
              <ChevronRight className={cn('h-3 w-3', nodeTypeTextColor(t))} strokeWidth={3} />
              {shortNodeType(t)}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// One level of the tree: a chevron, an icon that tells the level (phase,
// stage), the label, and its content indented underneath. What a folded
// branch holds is said once, on the branch; an open one shows it.
function TreeBranch({
  icon,
  label,
  folded,
  expanded,
  onToggle,
  children,
  id,
  compact,
  unitSlug,
}: {
  icon: React.ReactNode;
  label: string;
  /** What the branch holds, shown while it is folded ("3 documents"). */
  folded?: string;
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
          <Badge variant="outline" size="sm" className="font-normal text-muted-foreground">
            {humanizeSlug(unitSlug)}
          </Badge>
        )}
        {!expanded && folded && (
          <span className="text-2xs tabular-nums text-muted-foreground">{folded}</span>
        )}
      </button>
      {expanded && <div role="group">{children}</div>}
    </div>
  );
}

function StageBranch({
  stage,
  open,
  onOpenChange,
  commonSuffix,
  getNeighbors,
  itemsByArtifact,
  unitBranchItems,
  expandedDocs,
  toggleDoc,
  openArtifactPreview,
  openItemPreview,
}: {
  stage: StageNode;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  commonSuffix: string | null;
  getNeighbors: (id: string) => GraphNeighbor[];
  itemsByArtifact: Map<string, IntentGraphNode[]>;
  unitBranchItems: UnitBranchItem[];
  expandedDocs: Set<string>;
  toggleDoc: (docId: string) => void;
  openArtifactPreview: (id: string) => void;
  openItemPreview: (id: string) => void;
}) {
  const unitBranchItem = stage.unitSlug
    ? unitBranchItems.find(
        (item) =>
          item.unitSlug === stage.unitSlug &&
          (stage.sectionIndex == null || item.sectionIndex === stage.sectionIndex),
      )
    : null;
  const planIndex = stage.documents.findIndex(isCodeGenerationPlan);
  const summaryIndex = stage.documents.findIndex(isCodeSummary);
  const renderedBranchItem =
    (planIndex >= 0 || summaryIndex >= 0) && unitBranchItem?.branch ? unitBranchItem : null;
  const branchBeforeIndex =
    renderedBranchItem && summaryIndex >= 0
      ? planIndex >= 0
        ? Math.max(planIndex, summaryIndex)
        : summaryIndex
      : -1;
  const branchAfterIndex =
    renderedBranchItem && summaryIndex < 0 && planIndex >= 0 ? planIndex : -1;

  return (
    <TreeBranch
      icon={<Layers className="h-3 w-3 text-muted-foreground" />}
      label={stage.stageLabel}
      folded={plural(stage.documents.length, 'document')}
      expanded={open}
      onToggle={() => onOpenChange(!open)}
      id={`provenance-stage-${stage.key}`}
      compact
      unitSlug={stage.unitSlug}
    >
      <div className="space-y-0.5 pl-5">
        {stage.documents.map((doc, documentIndex) => {
          const docItems = itemsByArtifact.get(doc.id) ?? [];
          const visibleItems = docItems.filter((i) => !HIDDEN_ITEM_TYPES.has(i.type));
          const hasItems = visibleItems.length > 0;
          const isExpanded = expandedDocs.has(doc.id);

          return (
            <Fragment key={doc.id}>
              {documentIndex === branchBeforeIndex && renderedBranchItem && (
                <UnitBranchEntry item={renderedBranchItem} alignWithDocuments showPullRequests />
              )}
              <DocumentRow
                doc={doc}
                commonSuffix={commonSuffix}
                getNeighbors={getNeighbors}
                hasItems={hasItems}
                expanded={isExpanded}
                onToggle={() => toggleDoc(doc.id)}
                onPreview={() => openArtifactPreview(doc.id)}
              />
              {isExpanded && hasItems && (
                <div className="space-y-0.5 pl-5">
                  {visibleItems.map((item) => (
                    <DerivedItemRow
                      key={item.id}
                      item={item}
                      getNeighbors={getNeighbors}
                      onPreview={() => openItemPreview(item.id)}
                    />
                  ))}
                </div>
              )}
              {documentIndex === branchAfterIndex && renderedBranchItem && (
                <UnitBranchEntry item={renderedBranchItem} alignWithDocuments showPullRequests />
              )}
            </Fragment>
          );
        })}
      </div>
    </TreeBranch>
  );
}

function DocumentRow({
  doc,
  commonSuffix,
  getNeighbors,
  hasItems,
  expanded,
  onToggle,
  onPreview,
}: {
  doc: IntentArtifact;
  commonSuffix: string | null;
  getNeighbors: (id: string) => GraphNeighbor[];
  hasItems: boolean;
  expanded: boolean;
  onToggle: () => void;
  onPreview: () => void;
}) {
  const label = documentLabel(doc, commonSuffix);
  return (
    <div
      id={`artifact-${doc.id}`}
      className="group/doc flex min-h-8 items-center gap-1.5 rounded-md px-2 py-1 scroll-mt-4 hover:bg-muted/50 transition-colors"
    >
      {hasItems ? (
        <button
          type="button"
          onClick={onToggle}
          className="flex h-6 w-6 shrink-0 items-center justify-center rounded"
          aria-expanded={expanded}
          aria-label={`Expand items for ${label}`}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 text-muted-foreground" />
          )}
        </button>
      ) : (
        <span className="w-6 shrink-0" />
      )}
      <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
      <button
        type="button"
        className="min-w-0 flex-1 truncate text-left text-sm hover:underline"
        onClick={onPreview}
      >
        {label}
      </button>
      {doc.staleSince && (
        <AlertTriangle
          aria-label="Possibly stale"
          className="h-3 w-3 shrink-0 text-agent-waiting-fg"
        />
      )}
      <ArtifactHistoryDrawer artifact={doc} />
      <IntentGraphPopover neighbors={getNeighbors(doc.id)} className="shrink-0" />
      <DiscussButton entityType="artifact" entityId={doc.id} entityTitle={label} />
    </div>
  );
}

function CodeItemRow({ item }: { item: CodeItem }) {
  return (
    <div className="flex items-center justify-between gap-3 rounded-md px-2 py-1.5">
      <div className="min-w-0 space-y-1">
        <div className="flex items-center gap-2 text-sm font-medium">
          <span className="truncate">{item.repo || 'Repository'}</span>
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
          aria-label={`PR${item.prNumber ? ` #${item.prNumber}` : ''} for ${item.repo}`}
          className="inline-flex shrink-0 items-center gap-1 text-xs text-primary hover:underline"
        >
          <GitProviderIcon provider={item.provider} className="h-3 w-3" />
          PR{item.prNumber ? ` #${item.prNumber}` : ''}
        </a>
      )}
    </div>
  );
}

const artifactTs = (a: IntentArtifact) => (a.createdAt ? new Date(a.createdAt).getTime() : 0);

const artifactIdentity = (artifact: IntentArtifact) =>
  `${artifact.artifactType ?? ''} ${artifact.title ?? ''}`.toLowerCase().replaceAll(/[_\s]+/g, '-');

const isCodeGenerationPlan = (artifact: IntentArtifact) =>
  artifactIdentity(artifact).includes('code-generation-plan');

const isCodeSummary = (artifact: IntentArtifact) =>
  artifactIdentity(artifact).includes('code-summary');

function buildPhaseTree(
  documents: IntentArtifact[],
  getProvenance: (a: IntentArtifact) => DocProvenance,
  stageRows: IntentStageRow[],
  documentOrder: 'oldest-first' | 'newest-first',
): PhaseNode[] {
  const phases = new Map<string, PhaseNode>();
  const stageNodeMap = new Map<string, StageNode>();
  const rowByInstance = new Map(
    stageRows.filter((r) => r.stageInstanceId).map((r) => [r.stageInstanceId as string, r]),
  );

  for (const doc of documents) {
    const prov = getProvenance(doc);
    const phasePath = prov.phasePath || '__other__';
    const phaseLabel = prov.phaseLabel || 'Other';

    if (!phases.has(phasePath)) {
      phases.set(phasePath, { phasePath, phaseLabel, stages: [] });
    }

    const stageKey = stageBranchKey(phasePath, prov.stageId, prov.unitSlug, prov.sectionIndex);
    let stageNode = stageNodeMap.get(stageKey);
    if (!stageNode) {
      const row = doc.createdByStageInstanceId
        ? rowByInstance.get(doc.createdByStageInstanceId)
        : undefined;
      stageNode = {
        key: stageKey,
        stageId: prov.stageId ?? '__none__',
        stageLabel: prov.stageId ? displayStageName(prov.stageId) : 'General',
        unitSlug: prov.unitSlug,
        sectionIndex: prov.sectionIndex,
        documents: [],
        order: prov.stageOrder,
        active: row ? ACTIVE_STAGE_STATES.has(row.state) : false,
        latestCreatedAt: null,
      };
      stageNodeMap.set(stageKey, stageNode);
      phases.get(phasePath)!.stages.push(stageNode);
    }
    stageNode.documents.push(doc);
    if (
      doc.createdAt &&
      artifactTs(doc) >
        (stageNode.latestCreatedAt ? new Date(stageNode.latestCreatedAt).getTime() : 0)
    ) {
      stageNode.latestCreatedAt = doc.createdAt;
    }
  }

  for (const phase of phases.values()) {
    phase.stages.sort((a, b) => {
      const stageOrder =
        a.order !== b.order
          ? a.order - b.order
          : codepointCompare(a.unitSlug ?? '', b.unitSlug ?? '');
      // Same order (same stage, different units): tie-break with unitSlug for determinism.
      return documentOrder === 'newest-first' ? -stageOrder : stageOrder;
    });
    for (const stage of phase.stages) {
      stage.documents.sort((a, b) => {
        const chronological = artifactTs(a) - artifactTs(b);
        return documentOrder === 'newest-first' ? -chronological : chronological;
      });
    }
  }

  // Sort phases in workflow (AIDLC) order — earliest path first, __other__
  // always last. Codepoint comparison (not localeCompare) so '01' vs '10'
  // ordering never depends on the browser locale's collation rules.
  return [...phases.values()].toSorted((a, b) => {
    if (a.phasePath === '__other__') return 1;
    if (b.phasePath === '__other__') return -1;
    const phaseOrder = codepointCompare(a.phasePath, b.phasePath);
    return documentOrder === 'newest-first' ? -phaseOrder : phaseOrder;
  });
}

// The stage a reader most likely came for: the one still running or waiting
// on them; otherwise the one holding the newest document (the latest work).
// Finished stages stay folded (and unmounted) until asked for.
function pickDefaultOpenStage(tree: PhaseNode[]): string | null {
  const stages = tree.flatMap((phase) => phase.stages);
  if (stages.length === 0) return null;
  const active = stages.filter((stage) => stage.active);
  const candidates = active.length > 0 ? active : stages;
  let best: StageNode | null = null;
  let bestTs = -1;
  for (const stage of candidates) {
    const ts = stage.latestCreatedAt ? new Date(stage.latestCreatedAt).getTime() : 0;
    if (ts > bestTs || (ts === bestTs && best && stage.order >= best.order)) {
      best = stage;
      bestTs = ts;
    }
  }
  return (best ?? candidates[candidates.length - 1]).key;
}

function filterPhaseTree(tree: PhaseNode[], query: string, commonSuffix: string | null) {
  const matches = (doc: IntentArtifact, stage: StageNode) =>
    documentLabel(doc, commonSuffix).toLowerCase().includes(query) ||
    (doc.title ?? '').toLowerCase().includes(query) ||
    stage.stageLabel.toLowerCase().includes(query);
  return tree
    .map((phase) => ({
      ...phase,
      stages: phase.stages
        .map((stage) => ({
          ...stage,
          documents: stage.documents.filter((doc) => matches(doc, stage)),
        }))
        .filter((stage) => stage.documents.length > 0),
    }))
    .filter((phase) => phase.stages.length > 0);
}

function codepointCompare(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}
