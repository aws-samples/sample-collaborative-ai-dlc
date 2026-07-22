import { useCallback, useEffect, useState } from 'react';
import { simpleDiffStringWithCursor } from 'lib0/diff';
import type { GateAnswer, IntentDetail, IntentGate, IntentGraphNode } from '@/services/intents';
import { useIntent } from '@/contexts/IntentContext';
import { useIntentGraph } from '@/hooks/useIntentGraph';
import { useYjsDocument } from '@/hooks/useYjsDocument';
import { CollaborativeTextarea } from '@/components/CollaborativeTextarea';
import { ArtifactViewer } from '@/components/intent/ArtifactViewer';
import { scrollAndFlash } from '@/components/intent/workProductsFocus';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from '@/components/ui/accordion';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { generateColor } from '@/utils/colors';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronRight, FileText, Layers, SearchAlert, SearchCheck, Sparkles } from 'lucide-react';

// Identified-items grouping for the review gate. Mirrors the workbench's
// DerivedItemsSection ordering: canonical types first, unknowns alphabetical
// after; StoryMapEntry hidden (a slug-only view of Stories).
const REVIEW_ITEM_TYPE_ORDER = [
  'Requirement',
  'Story',
  'Persona',
  'Component',
  'Decision',
  'Contract',
];
const REVIEW_ITEM_HIDDEN_TYPES = new Set(['StoryMapEntry']);
const REVIEW_ITEM_GROUP_LABELS: Record<string, string> = {
  Requirement: 'Requirements',
  Story: 'Stories',
  Persona: 'Personas',
  Component: 'Components',
  Decision: 'Decisions',
  Contract: 'Contracts',
};

function reviewItemGroupLabel(type: string): string {
  return REVIEW_ITEM_GROUP_LABELS[type] ?? type;
}

function groupReviewItemsByType(items: IntentGraphNode[]): [string, IntentGraphNode[]][] {
  const byType = new Map<string, IntentGraphNode[]>();
  for (const item of items) {
    if (REVIEW_ITEM_HIDDEN_TYPES.has(item.type)) continue;
    if (!byType.has(item.type)) byType.set(item.type, []);
    byType.get(item.type)!.push(item);
  }
  return [...byType.entries()].toSorted(([a], [b]) => {
    const ia = REVIEW_ITEM_TYPE_ORDER.indexOf(a);
    const ib = REVIEW_ITEM_TYPE_ORDER.indexOf(b);
    if (ia !== -1 && ib !== -1) return ia - ib;
    if (ia !== -1) return -1;
    if (ib !== -1) return 1;
    return a.localeCompare(b);
  });
}

function ReviewStat({
  label,
  value,
  tone,
  onClick,
}: {
  label: string;
  value: string | number;
  tone?: 'ok' | 'warn';
  onClick?: () => void;
}) {
  const className = cn(
    'rounded-md border bg-background px-3 py-2',
    tone === 'ok' && 'border-agent-success/30 bg-agent-success/5',
    tone === 'warn' && 'border-agent-waiting/30 bg-agent-waiting/5',
    onClick &&
      'w-full text-left cursor-pointer transition-colors hover:border-primary/40 hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50',
  );
  const body = (
    <>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1 text-sm font-semibold">{value}</div>
    </>
  );
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={className}>
        {body}
      </button>
    );
  }
  return <div className={className}>{body}</div>;
}

function useCollaborativeReviewFeedback({
  projectId,
  intentId,
  humanTaskId,
  userName,
  enabled,
}: {
  projectId: string;
  intentId: string;
  humanTaskId: string;
  userName: string;
  enabled: boolean;
}) {
  const docId = enabled ? `intent-review-${intentId}-${humanTaskId}` : null;
  const { doc, remoteUsers, setCursor } = useYjsDocument(
    docId,
    userName,
    generateColor(userName || humanTaskId),
    { intentId, projectId },
  );
  const [feedback, setFeedbackState] = useState('');

  useEffect(() => {
    setFeedbackState('');
  }, [docId]);

  useEffect(() => {
    if (!doc || !docId) return;
    const text = doc.getText('feedback');
    const update = () => setFeedbackState(text.toString());
    text.observe(update);
    update();
    return () => text.unobserve(update);
  }, [doc, docId]);

  const setFeedback = useCallback(
    (value: string, cursorPos?: number) => {
      if (!doc || !docId) {
        setFeedbackState(value);
        return;
      }
      const text = doc.getText('feedback');
      const current = text.toString();
      if (current === value) return;
      const cursor = cursorPos ?? value.length;
      const diff = simpleDiffStringWithCursor(current, value, cursor);
      doc.transact(() => {
        if (diff.remove > 0) text.delete(diff.index, diff.remove);
        if (diff.insert) text.insert(diff.index, diff.insert);
      });
    },
    [doc, docId],
  );

  const getFeedback = useCallback(
    () => (doc && docId ? doc.getText('feedback').toString() : feedback),
    [doc, docId, feedback],
  );

  return { feedback, setFeedback, getFeedback, remoteUsers, setCursor };
}

export interface StageReviewPanelProps {
  gate: IntentGate;
  detail: IntentDetail;
  projectId: string;
  intentId: string;
  userName: string;
  onAnswer: (gate: IntentGate, input: GateAnswer) => Promise<void>;
  onBack: () => void;
}

export function StageReviewPanel({
  gate,
  detail,
  projectId,
  intentId,
  userName,
  onAnswer,
  onBack,
}: StageReviewPanelProps) {
  const [submitting, setSubmitting] = useState(false);
  const { stageNameOf } = useIntent();
  // Gate-time "skip to stage X" (stage-skip.js): the backend computed the
  // valid forward targets (every intermediate is CONDITIONAL); '' = none.
  // Rides the approve answer as { decision: 'approve', skipTo } and is
  // re-validated server-side.
  const [skipTo, setSkipTo] = useState('');
  const skipTargets = gate.skipTargets ?? [];
  const graph = useIntentGraph(projectId, intentId);
  const stage = detail.stages.find((s) => s.stageInstanceId === gate.stageInstanceId) ?? null;
  const artifacts = detail.artifacts.filter(
    (a) => a.createdByStageInstanceId === gate.stageInstanceId,
  );
  const sensors = detail.sensorRuns.filter((s) => s.stageInstanceId === gate.stageInstanceId);
  const reviewerRuns = sensors.filter((s) => s.sensorId.startsWith('reviewer:'));
  const reviewerFailCount = reviewerRuns.filter(
    (run) => run.result !== 'PASS' && run.detail?.verdict !== 'READY',
  ).length;
  // Open "At a glance" always, and "Reviewer Agent findings" too when the
  // reviewer agent flagged issues — surface the decision-relevant evidence.
  const [openSections, setOpenSections] = useState<string[]>(() =>
    reviewerFailCount > 0 ? ['summary', 'reviewer-findings'] : ['summary'],
  );
  const revealSection = (value: string) => {
    setOpenSections((prev) => (prev.includes(value) ? prev : [...prev, value]));
    scrollAndFlash(`review-section-${value}`);
  };
  const derivedItems = artifacts.flatMap(
    (artifact) => graph.itemsByArtifact.get(artifact.id) ?? [],
  );
  // Items shown in the "Identified items" section (StoryMapEntry hidden — a
  // slug-only view of Stories). Count and chips use the same list so they agree.
  const visibleDerivedItems = derivedItems.filter(
    (item) => !REVIEW_ITEM_HIDDEN_TYPES.has(item.type),
  );
  const artifactSummaries = artifacts.filter(
    (artifact) => artifact.summaryGist || (artifact.summaryClaims?.length ?? 0) > 0,
  );
  const pending = gate.status === 'pending';
  const reviewTitle = `Review ${stage?.stageId ?? gate.humanTaskId}`;
  const { feedback, setFeedback, getFeedback, remoteUsers, setCursor } =
    useCollaborativeReviewFeedback({
      projectId,
      intentId,
      humanTaskId: gate.humanTaskId,
      userName,
      enabled: pending,
    });
  const submit = async (decision: 'approve' | 'request-changes') => {
    setSubmitting(true);
    try {
      const currentFeedback = getFeedback();
      await onAnswer(gate, {
        status: decision === 'approve' ? 'approved' : 'rejected',
        answer:
          decision === 'approve'
            ? {
                decision,
                ...(skipTo ? { skipTo } : {}),
              }
            : { decision, feedback: currentFeedback },
      });
      onBack();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Card className="border-agent-waiting/30">
      <CardHeader className="space-y-3">
        <div>
          <CardTitle className="text-base">
            Review: {stageNameOf(gate.stageInstanceId ?? gate.humanTaskId)}
          </CardTitle>
          <p className="mt-1 text-sm text-muted-foreground">
            Review what the agent produced and approve or send it back with feedback.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-4">
          <ReviewStat
            label="Artifacts"
            value={artifacts.length}
            onClick={artifacts.length > 0 ? () => revealSection('full-artifacts') : undefined}
          />
          <ReviewStat
            label="Identified items"
            value={visibleDerivedItems.length}
            onClick={
              visibleDerivedItems.length > 0 ? () => revealSection('identified-items') : undefined
            }
          />
          <ReviewStat
            label="Reviewer findings"
            value={reviewerFailCount || 'None'}
            tone={reviewerFailCount ? 'warn' : 'ok'}
            onClick={reviewerRuns.length > 0 ? () => revealSection('reviewer-findings') : undefined}
          />
          <ReviewStat
            label="Status"
            value={
              pending ? 'Waiting for review' : gate.status === 'approved' ? 'Approved' : gate.status
            }
            tone={pending ? 'warn' : 'ok'}
          />
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Accordion
          type="multiple"
          value={openSections}
          onValueChange={setOpenSections}
          className="space-y-2"
        >
          <AccordionItem value="summary" className="rounded-lg border px-4">
            <AccordionTrigger className="py-3 hover:no-underline">
              <div className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-agent-running" />
                <span>At a glance</span>
                {artifactSummaries.length > 0 && (
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    Agent Summary
                  </Badge>
                )}
              </div>
            </AccordionTrigger>
            <AccordionContent className="space-y-3">
              {artifactSummaries.length > 0 ? (
                <div className="grid gap-3 md:grid-cols-2">
                  {artifactSummaries.map((artifact) => (
                    <div key={artifact.id} className="rounded-md border bg-background p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-sm font-medium">
                            {artifact.title || artifact.id}
                          </p>
                        </div>
                      </div>
                      {artifact.summaryGist && (
                        <p className="mt-2 text-sm text-muted-foreground">{artifact.summaryGist}</p>
                      )}
                      {artifact.summaryClaims && artifact.summaryClaims.length > 0 && (
                        <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
                          {artifact.summaryClaims.slice(0, 5).map((claim, idx) => (
                            <li key={`${artifact.id}-claim-${idx}`} className="flex gap-1.5">
                              <ChevronRight
                                className="mt-0.5 h-3 w-3 shrink-0 text-agent-running"
                                strokeWidth={3}
                              />
                              <span>{claim}</span>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">
                  No agent summary is available for this stage. Review the identified items and full
                  artifacts below.
                </p>
              )}
            </AccordionContent>
          </AccordionItem>

          {reviewerRuns.length > 0 && (
            <AccordionItem
              value="reviewer-findings"
              id="review-section-reviewer-findings"
              className="rounded-lg border px-4"
            >
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  {reviewerFailCount ? (
                    <SearchAlert className="h-4 w-4 text-destructive" />
                  ) : (
                    <SearchCheck className="h-4 w-4 text-muted-foreground" />
                  )}
                  <span>Reviewer Agent findings</span>
                  <Badge
                    variant={reviewerFailCount ? 'destructive' : 'secondary'}
                    className="h-5 px-1.5 text-[10px]"
                  >
                    {reviewerFailCount
                      ? `${reviewerFailCount} issue${reviewerFailCount === 1 ? '' : 's'}`
                      : 'No issues'}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                <div className="space-y-2 text-sm">
                  {reviewerRuns.map((run) => (
                    <div key={run.sensorRunId} className="rounded-md border p-2">
                      {typeof run.detail?.findings === 'string' && run.detail.findings ? (
                        // The findings markdown already carries the reviewer name
                        // and verdict (## Verdict, **Reviewer:**), so render it as
                        // the single source of truth — no duplicate badge/id row.
                        <div className="prose prose-sm max-w-none dark:prose-invert">
                          <ReactMarkdown remarkPlugins={[remarkGfm]}>
                            {run.detail.findings}
                          </ReactMarkdown>
                        </div>
                      ) : (
                        // No prose body — show the verdict + reviewer id so the
                        // run isn't blank.
                        <div className="flex items-center gap-2">
                          <Badge variant={run.result === 'PASS' ? 'default' : 'destructive'}>
                            {String(run.detail?.verdict ?? run.result)}
                          </Badge>
                          <span className="text-xs text-muted-foreground">{run.sensorId}</span>
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              </AccordionContent>
            </AccordionItem>
          )}

          {artifacts.length > 0 && (
            <AccordionItem
              value="full-artifacts"
              id="review-section-full-artifacts"
              className="rounded-lg border px-4"
            >
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span>Artifacts</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {artifacts.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {artifacts.map((artifact) => (
                  <ArtifactViewer key={artifact.id} artifact={artifact} />
                ))}
              </AccordionContent>
            </AccordionItem>
          )}

          {visibleDerivedItems.length > 0 && (
            <AccordionItem
              value="identified-items"
              id="review-section-identified-items"
              className="rounded-lg border px-4"
            >
              <AccordionTrigger className="py-3 hover:no-underline">
                <div className="flex items-center gap-2">
                  <Layers className="h-4 w-4 text-muted-foreground" />
                  <span>Identified items</span>
                  <Badge variant="secondary" className="h-5 px-1.5 text-[10px]">
                    {visibleDerivedItems.length}
                  </Badge>
                </div>
              </AccordionTrigger>
              <AccordionContent className="space-y-3">
                {groupReviewItemsByType(visibleDerivedItems).map(([type, items]) => (
                  <div key={type} className="space-y-1.5">
                    <div className="text-xs font-medium text-muted-foreground">
                      {reviewItemGroupLabel(type)}
                      <span className="ml-1.5 font-normal">({items.length})</span>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {items.map((item) => (
                        <Badge
                          key={item.id}
                          variant="outline"
                          className="max-w-full truncate"
                          title={item.slug ? `${item.slug}: ${item.label}` : item.label}
                        >
                          {item.slug ? `${item.slug}: ` : ''}
                          {item.label}
                        </Badge>
                      ))}
                    </div>
                  </div>
                ))}
              </AccordionContent>
            </AccordionItem>
          )}
        </Accordion>

        <section className="space-y-3 rounded-lg border border-agent-waiting/30 bg-agent-waiting/5 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 className="text-sm font-semibold">Decision</h2>
            <DiscussButton
              entityType="review"
              entityId={gate.humanTaskId}
              entityTitle={reviewTitle}
            />
          </div>
          {pending ? (
            <div className="space-y-3">
              <Label htmlFor="review-feedback">Feedback for the agent</Label>
              <CollaborativeTextarea
                id="review-feedback"
                value={feedback}
                onChange={setFeedback}
                onCursorChange={setCursor}
                remoteUsers={remoteUsers}
                rows={4}
                placeholder="What should the agent change before this stage can continue?"
                className="flex min-h-[60px] w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
                disabled={submitting}
              />
              {remoteUsers.size > 0 && (
                <div className="flex items-center gap-1">
                  {Array.from(remoteUsers.values()).map((u, i) => (
                    <div
                      key={i}
                      className="flex h-5 w-5 items-center justify-center rounded-full text-[10px] text-white"
                      style={{ backgroundColor: u.color }}
                    >
                      {u.name?.charAt(0)}
                    </div>
                  ))}
                  <span className="text-xs text-primary">collaborating</span>
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-lg border bg-background p-3 text-sm text-muted-foreground">
              Answered by {gate.answeredByName || gate.answeredBy || 'someone'}
              {gate.answeredAt ? ` at ${new Date(gate.answeredAt).toLocaleString()}` : ''}.
            </div>
          )}
          {pending && skipTargets.length > 0 && (
            <div>
              <Label htmlFor="skip-to-select" className="sr-only">
                After approval
              </Label>
              <Select
                value={skipTo || 'next'}
                onValueChange={(v) => setSkipTo(v === 'next' ? '' : v)}
                disabled={submitting}
              >
                <SelectTrigger id="skip-to-select" className="h-9 w-full text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {/* Name the COMPUTED next stage verbatim (upstream
                      2.2.6) — "Complete workflow" when this is the last
                      stage; the generic label only on legacy gates that
                      never carried the field. */}
                  <SelectItem value="next">
                    {gate.nextStageId !== undefined
                      ? gate.nextStageId
                        ? `Continue to ${gate.nextStageId}`
                        : 'Complete workflow'
                      : 'Continue to the next stage'}
                  </SelectItem>
                  {skipTargets.map((t) => (
                    <SelectItem key={t} value={t}>
                      Skip ahead to {t}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2 pt-1">
            <Button variant="outline" className="mr-auto" onClick={onBack}>
              Back to intent
            </Button>
            {pending && (
              <>
                <Button
                  variant="outline"
                  disabled={submitting || !feedback.trim()}
                  onClick={() => submit('request-changes')}
                >
                  Request changes
                </Button>
                <Button disabled={submitting} onClick={() => submit('approve')}>
                  {skipTo
                    ? `Approve & skip to ${skipTo}`
                    : gate.nextStageId !== undefined
                      ? gate.nextStageId
                        ? `Approve — continue to ${gate.nextStageId}`
                        : 'Approve — complete workflow'
                      : 'Approve stage'}
                </Button>
              </>
            )}
          </div>
          {pending && skipTo && (
            <p className="text-xs text-amber-600 dark:text-amber-500">
              Every CONDITIONAL stage between this one and {skipTo} will be marked skipped;
              downstream stages treat their outputs as absent by design. {skipTo} itself runs in
              full. You can re-add a skipped stage later by rewinding to it.
            </p>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
