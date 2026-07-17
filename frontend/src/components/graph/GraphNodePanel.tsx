import { type GraphNode, type GraphEdge } from '@/services/sprintGraph';
import { cn } from '@/lib/utils';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { X, ArrowRight, ArrowLeft, ChevronRight } from 'lucide-react';
import { type LayoutNode, getNodeCfg, EDGE_LABELS } from './graphTypes';

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface GraphNodePanelProps {
  selectedNodeData: LayoutNode;
  edges: GraphEdge[];
  nodeMap: Map<string, LayoutNode>;
  selectedNode: string;
  onSelectNode: (id: string | null) => void;
}

// ---------------------------------------------------------------------------
// GraphNodePanel
// ---------------------------------------------------------------------------

export function GraphNodePanel({
  selectedNodeData,
  edges,
  nodeMap,
  selectedNode,
  onSelectNode,
}: GraphNodePanelProps) {
  const cfg = getNodeCfg(selectedNodeData.type);
  const nodeEdges = edges.filter((e) => e.source === selectedNode || e.target === selectedNode);
  const outgoing = nodeEdges.filter((e) => e.source === selectedNode);
  const incoming = nodeEdges.filter((e) => e.target === selectedNode);

  return (
    <div className="absolute top-0 right-0 bottom-0 w-80 z-20 border-l bg-background/95 backdrop-blur-sm shadow-2xl flex flex-col">
      <div className="shrink-0 px-4 pt-4 pb-3" style={{ borderBottom: `2px solid ${cfg.color}` }}>
        <div className="flex items-start justify-between">
          <div className="flex items-start gap-3 min-w-0 flex-1">
            <div
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl shadow-md"
              style={{
                background: `linear-gradient(135deg, ${cfg.gradientFrom}, ${cfg.gradientTo})`,
              }}
            >
              {(() => {
                const Icon = cfg.icon;
                return <Icon className="h-5 w-5 text-white" />;
              })()}
            </div>
            <div className="min-w-0 flex-1">
              <span
                className="text-[10px] font-medium uppercase tracking-wider"
                style={{ color: cfg.color }}
              >
                {cfg.label}
              </span>
              <h3 className="text-sm font-semibold mt-0.5 leading-snug">
                {selectedNodeData.label}
              </h3>
            </div>
          </div>
          <Button
            variant="ghost"
            size="icon"
            className="h-7 w-7 shrink-0 -mt-1 -mr-1"
            onClick={() => onSelectNode(null)}
          >
            <X className="h-3.5 w-3.5" />
          </Button>
        </div>

        <div className="flex items-center gap-3 mt-3">
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <ArrowRight className="h-3 w-3" />
            <span>{outgoing.length} outgoing</span>
          </div>
          <div className="flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <ArrowLeft className="h-3 w-3" />
            <span>{incoming.length} incoming</span>
          </div>
        </div>
      </div>

      <ScrollArea className="flex-1">
        <div className="p-4 space-y-5">
          <NodeDetailContent node={selectedNodeData} />

          {nodeEdges.length > 0 && (
            <div>
              <span className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider">
                Relationships
              </span>

              {outgoing.length > 0 && (
                <div className="mt-2">
                  <span className="text-[9px] uppercase text-muted-foreground/60 tracking-wider font-medium flex items-center gap-1 mb-1">
                    <ArrowRight className="h-2.5 w-2.5" /> Outgoing
                  </span>
                  <div className="space-y-0.5">
                    {outgoing.map((edge, i) => {
                      const other = nodeMap.get(edge.target);
                      if (!other) return null;
                      const otherCfg = getNodeCfg(other.type);
                      return (
                        <button
                          key={`o-${i}`}
                          className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors group"
                          onClick={() => onSelectNode(edge.target)}
                        >
                          <span
                            className="h-2.5 w-2.5 rounded shrink-0 ring-1 ring-black/5"
                            style={{ backgroundColor: otherCfg.color }}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-[11px] truncate block font-medium">
                              {other.label}
                            </span>
                            <span className="text-[9px] text-muted-foreground/60">
                              {EDGE_LABELS[edge.label] || edge.label} &middot; {otherCfg.label}
                            </span>
                          </div>
                          <ChevronRight className="h-3 w-3 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}

              {incoming.length > 0 && (
                <div className="mt-2">
                  <span className="text-[9px] uppercase text-muted-foreground/60 tracking-wider font-medium flex items-center gap-1 mb-1">
                    <ArrowLeft className="h-2.5 w-2.5" /> Incoming
                  </span>
                  <div className="space-y-0.5">
                    {incoming.map((edge, i) => {
                      const other = nodeMap.get(edge.source);
                      if (!other) return null;
                      const otherCfg = getNodeCfg(other.type);
                      return (
                        <button
                          key={`i-${i}`}
                          className="flex items-center gap-2 w-full text-left rounded-lg px-2 py-1.5 hover:bg-muted/50 transition-colors group"
                          onClick={() => onSelectNode(edge.source)}
                        >
                          <span
                            className="h-2.5 w-2.5 rounded shrink-0 ring-1 ring-black/5"
                            style={{ backgroundColor: otherCfg.color }}
                          />
                          <div className="flex-1 min-w-0">
                            <span className="text-[11px] truncate block font-medium">
                              {other.label}
                            </span>
                            <span className="text-[9px] text-muted-foreground/60">
                              {EDGE_LABELS[edge.label] || edge.label} &middot; {otherCfg.label}
                            </span>
                          </div>
                          <ChevronRight className="h-3 w-3 text-muted-foreground/30 shrink-0 opacity-0 group-hover:opacity-100 transition-opacity" />
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {nodeEdges.length === 0 && (
            <div className="rounded-lg border border-dashed p-3 text-center">
              <p className="text-[11px] text-muted-foreground">No relationships yet</p>
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helper: safely get a string property from a node
// ---------------------------------------------------------------------------

function str(node: GraphNode, key: string): string {
  const v = node[key];
  if (v == null || v === '') return '';
  return String(v);
}

function tryParseJson(raw: string): unknown | null {
  if (!raw || typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Status badge component
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<string, string> = {
  todo: 'bg-muted text-muted-foreground',
  in_progress: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  done: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  PENDING: 'bg-amber-500/15 text-amber-700 dark:text-amber-400',
  PASSED: 'bg-emerald-500/15 text-emerald-700 dark:text-emerald-400',
  FAILED: 'bg-red-500/15 text-red-700 dark:text-red-400',
};

function StatusBadge({ status }: { status: string }) {
  const display = status.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  return (
    <span
      className={cn(
        'inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold',
        STATUS_STYLES[status] || 'bg-muted text-muted-foreground',
      )}
    >
      {display}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Detail field helper
// ---------------------------------------------------------------------------

function DetailField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <span className="text-[10px] uppercase font-medium text-muted-foreground/60 tracking-wider">
        {label}
      </span>
      <div className="mt-1">{children}</div>
    </div>
  );
}

function DetailText({ value, limit = 600 }: { value: string; limit?: number }) {
  if (!value) return <p className="text-[11px] text-muted-foreground/40 italic">Not provided</p>;
  const display = value.length > limit ? value.slice(0, limit) + '...' : value;
  return <p className="text-xs text-foreground leading-relaxed whitespace-pre-wrap">{display}</p>;
}

// ---------------------------------------------------------------------------
// Node Detail Content -- type-aware rendering
// ---------------------------------------------------------------------------

function NodeDetailContent({ node }: { node: GraphNode }) {
  const type = node.type;

  switch (type) {
    case 'Requirement': {
      const description = str(node, 'description');
      const criteria = str(node, 'acceptance_criteria');
      return (
        <div className="space-y-3">
          {description && (
            <DetailField label="Description">
              <DetailText value={description} />
            </DetailField>
          )}
          {criteria && (
            <DetailField label="Acceptance Criteria">
              <DetailText value={criteria} />
            </DetailField>
          )}
          {!description && !criteria && <EmptyContent />}
        </div>
      );
    }

    case 'UserStory': {
      const description = str(node, 'description');
      const points = str(node, 'story_points');
      return (
        <div className="space-y-3">
          {points && points !== '0' && (
            <DetailField label="Story Points">
              <div className="flex items-center gap-1.5">
                <span className="inline-flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-xs font-bold text-primary">
                  {points}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  point{points !== '1' ? 's' : ''} estimated
                </span>
              </div>
            </DetailField>
          )}
          {description && (
            <DetailField label="Description">
              <DetailText value={description} />
            </DetailField>
          )}
          {!description && (!points || points === '0') && <EmptyContent />}
        </div>
      );
    }

    case 'Task': {
      const status = str(node, 'status');
      const description = str(node, 'description');
      const deps = str(node, 'dependencies');
      const depList = tryParseJson(deps);
      const depCount = Array.isArray(depList) ? depList.length : 0;
      return (
        <div className="space-y-3">
          {status && (
            <DetailField label="Status">
              <StatusBadge status={status} />
            </DetailField>
          )}
          {description && (
            <DetailField label="Description">
              <DetailText value={description} />
            </DetailField>
          )}
          {depCount > 0 && (
            <DetailField label="Dependencies">
              <span className="text-xs text-muted-foreground">
                {depCount} task{depCount !== 1 ? 's' : ''} must complete first
              </span>
            </DetailField>
          )}
          {!status && !description && <EmptyContent />}
        </div>
      );
    }

    case 'CodeFile': {
      const filePath = str(node, 'file_path');
      const summary = str(node, 'summary');
      const commitRef = str(node, 'commit_ref');
      return (
        <div className="space-y-3">
          {filePath && (
            <DetailField label="File Path">
              <code className="text-[11px] font-mono bg-muted/40 rounded px-1.5 py-0.5 break-all">
                {filePath}
              </code>
            </DetailField>
          )}
          {summary && (
            <DetailField label="Summary">
              <DetailText value={summary} />
            </DetailField>
          )}
          {commitRef && (
            <DetailField label="Commit">
              <code className="text-[10px] font-mono text-muted-foreground bg-muted/40 rounded px-1.5 py-0.5">
                {commitRef.slice(0, 12)}
              </code>
            </DetailField>
          )}
          {!filePath && !summary && <EmptyContent />}
        </div>
      );
    }

    case 'Review': {
      const status = str(node, 'status');
      const comments = str(node, 'comments');
      const blindReview = str(node, 'blind_review');
      const fullReview = str(node, 'full_review');
      return (
        <div className="space-y-3">
          {status && (
            <DetailField label="Review Status">
              <StatusBadge status={status} />
            </DetailField>
          )}
          {comments && (
            <DetailField label="Comments">
              <DetailText value={comments} />
            </DetailField>
          )}
          {blindReview && (
            <DetailField label="Technical Review">
              <DetailText value={blindReview} />
            </DetailField>
          )}
          {fullReview && (
            <DetailField label="Business Review">
              <DetailText value={fullReview} />
            </DetailField>
          )}
          {!status && !comments && !blindReview && !fullReview && <EmptyContent />}
        </div>
      );
    }

    case 'Question': {
      const rawQuestions = str(node, 'questions');
      const agent = str(node, 'agent');
      const rawAnswer = str(node, 'structured_answer');
      const parsedQuestions = tryParseJson(rawQuestions) as Array<{
        text?: string;
        question?: string;
        type?: string;
        options?: Array<{ label: string; description?: string }>;
      }> | null;
      const parsedAnswer = tryParseJson(rawAnswer) as {
        answers?: Array<{ selectedOptions?: number[]; freeText?: string }>;
      } | null;
      const answerItems = parsedAnswer?.answers;

      return (
        <div className="space-y-3">
          {agent && (
            <DetailField label="Asked by">
              <span className="text-xs font-medium capitalize">{agent} agent</span>
            </DetailField>
          )}
          {Array.isArray(parsedQuestions) && parsedQuestions.length > 0 && (
            <div className="space-y-3">
              {parsedQuestions.map((q, i) => {
                const questionText = q?.text || q?.question || '';
                const options = q?.options;
                const a = Array.isArray(answerItems) ? answerItems[i] : null;
                const selectedIdxs = a?.selectedOptions || [];
                const freeText = a?.freeText || '';
                const hasAnswer = selectedIdxs.length > 0 || !!freeText;

                return (
                  <div key={i} className="rounded-lg border overflow-hidden">
                    <div className="bg-muted/30 px-3 py-2">
                      <span className="text-[9px] uppercase font-medium text-muted-foreground/60 tracking-wider">
                        Question {parsedQuestions.length > 1 ? i + 1 : ''}
                      </span>
                      <p className="text-xs leading-relaxed mt-0.5 font-medium">{questionText}</p>
                    </div>

                    {hasAnswer && (
                      <div className="px-3 py-2 bg-emerald-500/5">
                        <span className="text-[9px] uppercase font-medium text-emerald-600 dark:text-emerald-400 tracking-wider">
                          Answer
                        </span>
                        {selectedIdxs.length > 0 && Array.isArray(options) && (
                          <div className="mt-1 space-y-0.5">
                            {selectedIdxs.map((idx) => {
                              const opt = options[idx];
                              return (
                                <div key={idx} className="flex items-start gap-1.5">
                                  <span className="text-emerald-600 dark:text-emerald-400 text-xs mt-0.5 shrink-0">
                                    &#10003;
                                  </span>
                                  <span className="text-xs">
                                    {opt?.label || `Option ${idx + 1}`}
                                  </span>
                                </div>
                              );
                            })}
                          </div>
                        )}
                        {freeText && (
                          <p className="text-xs leading-relaxed mt-1 text-foreground/80 italic">
                            {freeText}
                          </p>
                        )}
                      </div>
                    )}

                    {!hasAnswer && (
                      <div className="px-3 py-2">
                        <span className="text-[10px] text-muted-foreground/50 italic">
                          Awaiting answer
                        </span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
          {!Array.isArray(parsedQuestions) && !agent && <EmptyContent />}
        </div>
      );
    }

    case 'GeneralInfo': {
      const infoType = str(node, 'type');
      const content = str(node, 'content');
      return (
        <div className="space-y-3">
          {infoType && infoType !== 'GeneralInfo' && (
            <DetailField label="Category">
              <Badge variant="outline" className="text-[10px]">
                {infoType}
              </Badge>
            </DetailField>
          )}
          {content && (
            <DetailField label="Content">
              <DetailText value={content} />
            </DetailField>
          )}
          {!content && <EmptyContent />}
        </div>
      );
    }

    case 'UnitPullRequest':
    case 'PullRequest': {
      const prUrl = str(node, 'pr_url');
      const prNumber = str(node, 'pr_number');
      const branch = str(node, 'branch') || str(node, 'source_branch');
      const baseBranch = str(node, 'base_branch') || str(node, 'target_branch');
      const unitSlug = str(node, 'unit_slug');
      const sectionIndex = str(node, 'section_index');
      const provider = str(node, 'provider');
      const state = str(node, 'state');
      return (
        <div className="space-y-3">
          {unitSlug && (
            <DetailField label="Unit">
              <span className="text-xs font-semibold">
                {unitSlug}
                {sectionIndex ? ` · section ${sectionIndex}` : ''}
              </span>
            </DetailField>
          )}
          {(provider || state) && (
            <DetailField label="Review state">
              <span className="text-xs">{[provider, state].filter(Boolean).join(' · ')}</span>
            </DetailField>
          )}
          {prNumber && (
            <DetailField label="Pull Request">
              <span className="text-xs font-semibold">#{prNumber}</span>
            </DetailField>
          )}
          {branch && (
            <DetailField label="Branch">
              <div className="flex items-center gap-1.5 text-[11px]">
                <code className="font-mono bg-muted/40 rounded px-1.5 py-0.5">{branch}</code>
                {baseBranch && (
                  <>
                    <ArrowRight className="h-3 w-3 text-muted-foreground/40" />
                    <code className="font-mono bg-muted/40 rounded px-1.5 py-0.5">
                      {baseBranch}
                    </code>
                  </>
                )}
              </div>
            </DetailField>
          )}
          {prUrl && (
            <DetailField label="Link">
              <a
                href={prUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-xs text-primary hover:underline underline-offset-2 break-all"
              >
                Open link
              </a>
            </DetailField>
          )}
          {!prNumber && !prUrl && <EmptyContent />}
        </div>
      );
    }

    default: {
      const internalKeys = new Set([
        'id',
        'type',
        'label',
        'x',
        'y',
        'vx',
        'vy',
        'pinned',
        'sprint_id',
        'createdAt',
        'created_at',
      ]);
      const entries = Object.entries(node)
        .filter(([k]) => !internalKeys.has(k))
        .filter(([, v]) => v != null && v !== '');
      if (entries.length === 0) return <EmptyContent />;
      return (
        <div className="space-y-3">
          {entries.map(([key, value]) => (
            <DetailField key={key} label={key.replace(/([A-Z])/g, ' $1').replace(/_/g, ' ')}>
              <DetailText value={String(value)} />
            </DetailField>
          ))}
        </div>
      );
    }
  }
}

function EmptyContent() {
  return (
    <div className="rounded-lg border border-dashed p-3 text-center">
      <p className="text-[11px] text-muted-foreground">No details available yet</p>
    </div>
  );
}
