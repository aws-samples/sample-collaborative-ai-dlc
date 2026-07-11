import { Fragment, useMemo } from 'react';
import { AccordionContent, AccordionItem, AccordionTrigger } from '@/components/ui/accordion';
import { Badge } from '@/components/ui/badge';
import { AlertTriangle, ChevronRight, FileText } from 'lucide-react';
import type { IntentArtifact, IntentGraphNode } from '@/services/intents';
import type { IntentStageRow } from '@/contexts/IntentContext';
import type { GraphNeighbor } from '@/hooks/useIntentGraph';
import { getTimeAgo } from '@/lib/timeAgo';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { IntentGraphPopover } from '@/components/intent/IntentGraphPopover';
import { DerivedItemCountChip } from '@/components/intent/DerivedItemCountChip';

// The "Documents" accordion group on the intent workbench: long-form markdown
// artifacts, grouped by workflow phase (latest first) then stage (latest plan
// stage first) then date desc, each row opening the preview panel. Mirrors the
// DerivedItemsSection extraction so IntentView stays a thin composition layer.

export const DOCUMENTS_ACCORDION_VALUE = 'documents';

// Document heuristic: long-form markdown content (opened in the preview panel
// instead of expanded inline). Exported so callers (focus handler, default-open
// seeding) classify artifacts with the same rule the section renders by.
const DOCUMENT_TYPE_RE = /markdown|document|statement|research|report|notes?/i;
const MD_HEADING_RE = /^#{1,3}\s/m;

export function isDocumentArtifact(a: IntentArtifact): boolean {
  if (a.artifactType && DOCUMENT_TYPE_RE.test(a.artifactType)) return true;
  const content = a.content ?? '';
  return content.length > 600 && MD_HEADING_RE.test(content);
}

// kebab / snake stageId → Title Case ("requirements-analysis" → "Requirements
// Analysis"). Used for the per-document stage badge.
function humanizeStageId(stageId: string): string {
  return stageId.replace(/[_-]/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

// Agents suffix nearly every document title with a self-generated product name
// + scope, either as a dash tail ("… — Plant Identifier MVP") or a parenthetical
// ("… (Plant Identifier MVP)"). On the intent page that suffix is pure
// redundancy. It is NOT the intent title (that's the prompt), so we can't match
// a known string — instead we DETECT the common trailing token across the doc
// set and strip it (display only; stored title / discuss entityTitle keep the
// full text).

// Extract a title's trailing suffix token, whichever form it takes:
//   "Foo — Bar"      → "Bar"      (dash tail)
//   "Foo (Bar)"      → "Bar"      (parenthetical)
//   "Foo — Baz (Bar)" → "Bar"     (parenthetical wins — it's the outermost tail)
// Returns null when the title has no such trailing suffix.
const SUFFIX_PAREN_RE = /\(\s*([^()]+?)\s*\)\s*$/;
const SUFFIX_DASH_RE = /[—–-]\s*([^—–()]+?)\s*$/;
function trailingSuffixToken(title: string): string | null {
  const t = title.trim();
  const paren = SUFFIX_PAREN_RE.exec(t);
  if (paren) return paren[1].trim();
  const dash = SUFFIX_DASH_RE.exec(t);
  if (dash) return dash[1].trim();
  return null;
}

// Detect the redundant suffix shared across the document set: the trailing token
// that recurs in ≥2 documents (and in >1 distinct title). Returns null when no
// token repeats — then nothing is stripped (safe no-op). This deliberately does
// NOT fire on a meaningful one-off dash segment like "— Infrastructure".
function detectCommonSuffix(titles: string[]): string | null {
  const counts = new Map<string, number>();
  for (const title of titles) {
    const token = trailingSuffixToken(title);
    if (token) counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  let best: string | null = null;
  let bestCount = 1; // require ≥2 to qualify
  for (const [token, count] of counts) {
    if (count > bestCount) {
      best = token;
      bestCount = count;
    }
  }
  return best;
}

// Strip a detected suffix token from one title, in whichever form it trails
// (parenthetical or dash). Only the TRAILING occurrence is removed, so a
// meaningful earlier dash segment survives ("Code Summary — Infrastructure
// (Plant Identifier MVP)" → "Code Summary — Infrastructure"). Case/whitespace
// tolerant. Never blanks the title.
function stripSuffix(title: string, token: string | null): string {
  const t = title.trim();
  if (!token) return t;
  const esc = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const paren = new RegExp(`\\s*\\(\\s*${esc}\\s*\\)\\s*$`, 'i');
  const dash = new RegExp(`\\s*[—–-]\\s*${esc}\\s*$`, 'i');
  const stripped = t.replace(paren, '').replace(dash, '').trim();
  return stripped.length > 0 ? stripped : t;
}

// A document's producing stage + phase, resolved through the SAME normalized
// vocabulary the rest of the UI uses (IntentContext.stageRows): live stage rows
// carry the backend phaseId ('ideation') while the compiled plan carries the
// canonical phasePath ('01'); stageRows reconciles them to the path. Grouping
// on the raw detail.stages[].phase would split/misplace phases for custom
// workflows or moved placements. Missing joins fall back to null → an "Other"
// bucket sorted last.
interface DocProvenance {
  stageId: string | null;
  stageLabel: string | null;
  /** Canonical plan order of the producing stage, for intra-phase sorting. */
  stageOrder: number;
  phaseLabel: string;
  /** Canonical phase path (e.g. '01', '01.02') from stageRows. */
  phasePath: string;
  /** Unit lane of the producing stage instance; null for once-per-workflow stages. */
  unitSlug: string | null;
}

// Sentinel path for the ungrouped bucket — sorts last under a reverse (desc)
// path comparison because '' < any real path.
const NO_PHASE_PATH = '';
const NO_PHASE_LABEL = 'Other';

// A run within a phase: either a "common" (once-per-workflow) chunk rendered
// flat, or a single unit lane rendered under a sub-header. Each unit appears
// exactly once (all its docs, across stages) — the unit block is contiguous;
// common chunks sit above/below it by recency.
interface UnitDocGroup {
  unitSlug: string | null;
  docs: IntentArtifact[];
}

interface PhaseDocGroup {
  phaseLabel: string;
  phasePath: string;
  docs: IntentArtifact[];
  /** Ordered runs, populated only when the phase spans 2+ units. */
  unitGroups: UnitDocGroup[];
}

const artifactTs = (a: IntentArtifact) => (a.createdAt ? new Date(a.createdAt).getTime() : 0);

// Group documents by phase (latest phase first), then within each phase by
// stage (latest plan stage first), then date desc. Phase/stage ordering use the
// canonical plan order carried on stageRows so it matches the rest of the UI.
// When a phase spans 2+ distinct units, its docs are split into ordered runs:
// contiguous "common" chunks (positioned by recency) plus ONE group per unit,
// with the whole unit block inserted where the units first appear in the sort.
function groupDocumentsByPhase(
  documents: IntentArtifact[],
  provenanceOf: (a: IntentArtifact) => DocProvenance,
): PhaseDocGroup[] {
  const byPhase = new Map<string, PhaseDocGroup>();
  const provCache = new Map<string, DocProvenance>();
  const prov = (a: IntentArtifact): DocProvenance => {
    let p = provCache.get(a.id);
    if (!p) {
      p = provenanceOf(a);
      provCache.set(a.id, p);
    }
    return p;
  };

  for (const a of documents) {
    const p = prov(a);
    if (!byPhase.has(p.phasePath)) {
      byPhase.set(p.phasePath, {
        phaseLabel: p.phaseLabel,
        phasePath: p.phasePath,
        docs: [],
        unitGroups: [],
      });
    }
    byPhase.get(p.phasePath)!.docs.push(a);
  }

  const sortDocs = (docs: IntentArtifact[]) =>
    docs.sort((a, b) => {
      const pa = prov(a);
      const pb = prov(b);
      if (pa.stageOrder !== pb.stageOrder) return pb.stageOrder - pa.stageOrder; // latest stage first
      const sa = pa.stageId ?? '';
      const sb = pb.stageId ?? '';
      if (sa !== sb) return sa.localeCompare(sb); // stable within same order
      return artifactTs(b) - artifactTs(a); // date desc within a stage
    });

  for (const g of byPhase.values()) {
    sortDocs(g.docs);

    // Only split into unit runs when the phase genuinely spans 2+ units.
    const distinctUnits = new Set(g.docs.map((a) => prov(a).unitSlug).filter((u) => u !== null));
    if (distinctUnits.size < 2) continue;

    // Build ONE group per unit (deduped, docs kept in phase sort order), then
    // order the units by recency (newest doc first).
    const byUnit = new Map<string, UnitDocGroup>();
    for (const a of g.docs) {
      const unitSlug = prov(a).unitSlug;
      if (unitSlug === null) continue;
      if (!byUnit.has(unitSlug)) byUnit.set(unitSlug, { unitSlug, docs: [] });
      byUnit.get(unitSlug)!.docs.push(a);
    }
    const recency = (u: UnitDocGroup) => Math.max(...u.docs.map(artifactTs));
    const unitBlock = [...byUnit.values()].toSorted((a, b) => recency(b) - recency(a));

    // Walk the sorted docs, emitting contiguous common chunks in place; the
    // entire unit block is inserted at the position of the FIRST unit doc.
    const runs: UnitDocGroup[] = [];
    let unitBlockInserted = false;
    for (const a of g.docs) {
      if (prov(a).unitSlug !== null) {
        if (!unitBlockInserted) {
          runs.push(...unitBlock);
          unitBlockInserted = true;
        }
        continue; // unit docs live in unitBlock, not the common chunks
      }
      const last = runs.at(-1);
      if (last && last.unitSlug === null) last.docs.push(a);
      else runs.push({ unitSlug: null, docs: [a] });
    }
    g.unitGroups = runs;
  }

  // Phases: latest first (reverse path). The "Other" bucket (path '') sorts last.
  return [...byPhase.values()].toSorted((a, b) => b.phasePath.localeCompare(a.phasePath));
}

interface DocumentsSectionProps {
  documents: IntentArtifact[];
  /** Normalized stage rows (IntentContext) — the phase/stage provenance source. */
  stageRows: IntentStageRow[];
  /** phasePath → display name (IntentContext.phaseNameOf). */
  phaseNameOf: (phasePath: string) => string;
  getNeighbors: (id: string) => GraphNeighbor[];
  itemsByArtifact: Map<string, IntentGraphNode[]>;
  openArtifactPreview: (id: string) => void;
}

export function DocumentsSection({
  documents,
  stageRows,
  phaseNameOf,
  getNeighbors,
  itemsByArtifact,
  openArtifactPreview,
}: DocumentsSectionProps) {
  // The redundant product/scope suffix agents append to every doc title, detected
  // across this intent's document set (not a known string). Stripped for display.
  const commonSuffix = useMemo(
    () => detectCommonSuffix(documents.map((a) => a.title ?? '')),
    [documents],
  );

  const docProvenance = useMemo(() => {
    const rowByInstance = new Map(
      stageRows.filter((r) => r.stageInstanceId).map((r) => [r.stageInstanceId as string, r]),
    );
    return (a: IntentArtifact): DocProvenance => {
      const row = a.createdByStageInstanceId
        ? rowByInstance.get(a.createdByStageInstanceId)
        : undefined;
      const stageId = row?.stageId ?? null;
      const phasePath = row?.phase ?? null;
      return {
        stageId,
        stageLabel: stageId ? humanizeStageId(stageId) : null,
        stageOrder: row?.order ?? -1,
        phaseLabel: phasePath ? phaseNameOf(phasePath) : NO_PHASE_LABEL,
        phasePath: phasePath ?? NO_PHASE_PATH,
        unitSlug: row?.unitSlug ?? null,
      };
    };
  }, [stageRows, phaseNameOf]);

  const phaseGroups = useMemo(
    () => groupDocumentsByPhase(documents, docProvenance),
    [documents, docProvenance],
  );

  if (documents.length === 0) return null;

  return (
    <AccordionItem value={DOCUMENTS_ACCORDION_VALUE} className="rounded-md border px-3">
      <AccordionTrigger className="py-3 hover:no-underline">
        <div className="flex items-center gap-2">
          <FileText className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm font-medium">Document{documents.length > 1 ? 's' : ''}</span>
          <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
            {documents.length}
          </Badge>
        </div>
      </AccordionTrigger>
      <AccordionContent className="space-y-3 pb-3">
        {phaseGroups.map((group) => {
          const renderRow = (a: IntentArtifact) => {
            const stageLabel = docProvenance(a).stageLabel;
            return (
              // role=button div (not <button>): the row hosts interactive
              // children (discuss, graph popover, items chip) and nested
              // buttons are invalid HTML.
              <div
                key={a.id}
                id={`artifact-${a.id}`}
                role="button"
                tabIndex={0}
                className="group/doc flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left scroll-mt-4 hover:bg-muted/50 transition-colors"
                onClick={() => openArtifactPreview(a.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openArtifactPreview(a.id);
                  }
                }}
              >
                <FileText className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                {stageLabel && (
                  <Badge
                    variant="outline"
                    className="h-4 shrink-0 px-1 text-[9px] font-normal text-muted-foreground"
                  >
                    {stageLabel}
                  </Badge>
                )}
                <span className="min-w-0 flex-1 truncate text-sm">
                  {a.title ? stripSuffix(a.title, commonSuffix) : a.id}
                </span>
                {a.staleSince && (
                  <AlertTriangle
                    aria-label="Possibly stale — an upstream document was edited"
                    className="h-3 w-3 shrink-0 text-agent-waiting"
                  />
                )}
                {a.createdAt && (
                  <span className="shrink-0 text-[11px] text-muted-foreground/60">
                    {getTimeAgo(a.createdAt)}
                  </span>
                )}
                <DerivedItemCountChip
                  artifactId={a.id}
                  count={itemsByArtifact.get(a.id)?.length ?? 0}
                />
                <IntentGraphPopover neighbors={getNeighbors(a.id)} className="shrink-0" />
                <DiscussButton
                  entityType="artifact"
                  entityId={a.id}
                  entityTitle={a.title || a.id}
                  className="opacity-0 group-hover/doc:opacity-100 transition-opacity"
                />
                <ChevronRight
                  aria-hidden="true"
                  className="h-3 w-3 shrink-0 text-muted-foreground/40 opacity-0 group-hover/doc:opacity-100 transition-opacity"
                />
              </div>
            );
          };

          return (
            <div key={group.phasePath || 'other'} className="space-y-0.5">
              <div className="flex items-center gap-1.5 pt-1">
                <span className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground">
                  {group.phaseLabel}
                </span>
                <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                  {group.docs.length}
                </Badge>
              </div>
              {group.unitGroups.length > 0
                ? group.unitGroups.map((unit, i) =>
                    unit.unitSlug === null ? (
                      // Common (once-per-workflow) run: rendered flat, no sub-header.
                      <Fragment key={`run-${i}`}>{unit.docs.map(renderRow)}</Fragment>
                    ) : (
                      <div key={`run-${i}`} className="space-y-0.5 pl-3">
                        <div className="flex items-center gap-1.5 pt-1">
                          <span className="text-[10px] font-medium tracking-wide text-muted-foreground/80">
                            {humanizeStageId(unit.unitSlug)}
                          </span>
                          <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                            {unit.docs.length}
                          </Badge>
                        </div>
                        {unit.docs.map(renderRow)}
                      </div>
                    ),
                  )
                : group.docs.map(renderRow)}
            </div>
          );
        })}
      </AccordionContent>
    </AccordionItem>
  );
}
