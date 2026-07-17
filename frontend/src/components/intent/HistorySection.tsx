import { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Compass, FileQuestion } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { DiscussButton } from '@/components/discussion/DiscussButton';
import { useIntent } from '@/contexts/IntentContext';
import { humanizeStageId } from '@/components/intent/documentHelpers';
import { formatTimelineTimestamp } from '@/lib/timeAgo';
import { focusWorkProduct } from '@/components/intent/workProductsFocus';
import type { IntentGate, IntentSteering } from '@/services/intents';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

interface HistorySectionProps {
  questionGates: IntentGate[];
  steering: IntentSteering[];
  influencedArtifactsByQuestion: Map<string, { id: string; title: string }[]>;
}

export function HistorySection({
  questionGates,
  steering,
  influencedArtifactsByQuestion,
}: HistorySectionProps) {
  const [expanded, setExpanded] = useState(false);

  // Exclude currently pending gates — those are shown in PendingQuestionsTabs.
  const historicalGates = useMemo(
    () => questionGates.filter((g) => g.status !== 'pending'),
    [questionGates],
  );

  if (historicalGates.length === 0 && steering.length === 0) return null;

  return (
    <div className="space-y-1" data-testid="history-section">
      <button
        type="button"
        className="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-muted/50"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        )}
        <FileQuestion className="h-4 w-4 text-muted-foreground" />
        <span className="text-sm font-medium text-muted-foreground">
          Past questions & corrections
        </span>
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
          {historicalGates.length + steering.length}
        </Badge>
      </button>

      {expanded && (
        <div className="space-y-2 pl-5">
          <QuestionHistoryCompact
            gates={historicalGates}
            influencedArtifactsByQuestion={influencedArtifactsByQuestion}
          />
          {steering.length > 0 && <SteeringCompact steering={steering} />}
        </div>
      )}
    </div>
  );
}

function QuestionHistoryCompact({
  gates,
  influencedArtifactsByQuestion,
}: {
  gates: IntentGate[];
  influencedArtifactsByQuestion: Map<string, { id: string; title: string }[]>;
}) {
  const { stageNameOf, stageRows } = useIntent();
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const groupedByStage = useMemo(() => {
    // Plan position of each stage instance, so groups follow the AIDLC
    // workflow order (phase, then stage order) instead of gate arrival order.
    const planPosition = new Map(
      stageRows
        .filter((r) => r.stageInstanceId)
        .map((r) => [r.stageInstanceId as string, { phase: r.phase ?? '', order: r.order ?? -1 }]),
    );

    const groups = new Map<
      string,
      { key: string; label: string; phase: string; order: number; gates: IntentGate[] }
    >();
    for (const gate of gates) {
      const key = gate.stageInstanceId ?? '__unknown__';
      if (!groups.has(key)) {
        // stageNameOf falls back to the raw instance id when the stage row is
        // gone — don't title-case an opaque id, use the generic label instead.
        const resolved = gate.stageInstanceId ? stageNameOf(gate.stageInstanceId) : null;
        const position = gate.stageInstanceId ? planPosition.get(gate.stageInstanceId) : undefined;
        groups.set(key, {
          key,
          label:
            resolved && resolved !== gate.stageInstanceId
              ? humanizeStageId(resolved)
              : 'Agent question',
          phase: position?.phase ?? '\uffff',
          order: position?.order ?? Number.MAX_SAFE_INTEGER,
          gates: [],
        });
      }
      groups.get(key)!.gates.push(gate);
    }

    const chronoKey = (g: IntentGate) => g.answeredAt ?? g.createdAt ?? '\uffff';
    for (const group of groups.values()) {
      group.gates.sort((a, b) => chronoKey(a).localeCompare(chronoKey(b)));
    }
    return [...groups.values()].toSorted((a, b) => {
      if (a.phase !== b.phase) return a.phase < b.phase ? -1 : 1;
      return a.order - b.order;
    });
  }, [gates, stageNameOf, stageRows]);

  return (
    <div className="space-y-2">
      {groupedByStage.map((group) => (
        <div key={group.key} className="space-y-0.5">
          {groupedByStage.length > 1 && (
            <div className="flex items-center gap-1.5 px-2 pt-1">
              <span className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground">
                {group.label}
              </span>
              <Badge variant="secondary" className="h-4 px-1 text-[9px]">
                {group.gates.length}
              </Badge>
            </div>
          )}
          {group.gates.map((gate) => (
            <CompactQuestionRow
              key={gate.humanTaskId}
              gate={gate}
              expanded={expandedId === gate.humanTaskId}
              onToggle={() =>
                setExpandedId(expandedId === gate.humanTaskId ? null : gate.humanTaskId)
              }
              influencedArtifacts={influencedArtifactsByQuestion.get(gate.humanTaskId) ?? []}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function statusDotClass(gate: IntentGate): string {
  if (gate.status === 'superseded') return 'bg-muted-foreground';
  if (gate.status !== 'pending' || gate.answeredAt) return 'bg-agent-success';
  return 'bg-agent-waiting';
}

function CompactQuestionRow({
  gate,
  expanded,
  onToggle,
  influencedArtifacts,
}: {
  gate: IntentGate;
  expanded: boolean;
  onToggle: () => void;
  influencedArtifacts: { id: string; title: string }[];
}) {
  const { detail, steering, reviseGate } = useIntent();
  const questions = parseGateQuestions(gate.questions);
  const answer = formatGateAnswer(gate.answer, questions);
  const superseded = gate.status === 'superseded';
  const answered = !superseded && (gate.status !== 'pending' || Boolean(gate.answeredAt));

  const [reviseOpen, setReviseOpen] = useState(false);
  const [revision, setRevision] = useState('');
  const [revising, setRevising] = useState(false);
  const [reviseError, setReviseError] = useState<string | null>(null);
  const revisionSteer = gate.revisionSteerId
    ? (steering.find((s) => s.steerId === gate.revisionSteerId) ?? null)
    : null;
  const intentStatus = detail?.intent.status ?? '';
  const canRevise = answered && !['SUCCEEDED', 'CANCELLED'].includes(intentStatus);

  const handleRevise = async () => {
    if (!revision.trim()) return;
    setRevising(true);
    setReviseError(null);
    try {
      await reviseGate(gate, revision.trim());
      setReviseOpen(false);
      setRevision('');
    } catch (err) {
      setReviseError(err instanceof Error ? err.message : 'Failed to revise');
    } finally {
      setRevising(false);
    }
  };

  const preview = questions[0]?.text || 'Question';

  return (
    <div
      id={`question-${gate.humanTaskId}`}
      className="scroll-mt-4"
      data-testid={`history-row-${gate.humanTaskId}`}
    >
      {/* No nested interactive: toggle and discuss are siblings in a flex row */}
      <div className="flex items-center gap-2 rounded-md px-2 py-1.5 hover:bg-muted/40 transition-colors">
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={onToggle}
          aria-expanded={expanded}
        >
          {expanded ? (
            <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          <span className={cn('h-1.5 w-1.5 rounded-full shrink-0', statusDotClass(gate))} />
          <span className="min-w-0 flex-1 truncate text-xs">{preview}</span>
          {superseded && (
            <span className="shrink-0 text-[10px] text-muted-foreground/60">retired</span>
          )}
          {answered && (gate.answeredByName || gate.answeredAt) && (
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {[
                gate.answeredByName,
                gate.answeredAt ? formatTimelineTimestamp(gate.answeredAt) : null,
              ]
                .filter(Boolean)
                .join(' · ')}
            </span>
          )}
        </button>
        <DiscussButton
          entityType="question"
          entityId={gate.humanTaskId}
          entityTitle={preview}
          className="shrink-0"
        />
      </div>

      {expanded && (
        <div className="ml-7 mt-1 space-y-2 rounded-md border bg-card px-3 py-2">
          {questions.map((q, idx) => (
            <div key={idx} className="text-sm prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown remarkPlugins={[remarkGfm]}>
                {questions.length > 1 ? `**Q${idx + 1}.** ${q.text || ''}` : q.text || ''}
              </ReactMarkdown>
            </div>
          ))}

          {answered && answer && (
            <div className="rounded border border-agent-success/20 bg-agent-success/[0.04] px-2 py-1.5">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  Answer
                </p>
                {(gate.answeredByName || gate.answeredAt) && (
                  <span className="text-[10px] text-muted-foreground/70">
                    {[
                      gate.answeredByName ? `by ${gate.answeredByName}` : null,
                      gate.answeredAt ? formatTimelineTimestamp(gate.answeredAt) : null,
                    ]
                      .filter(Boolean)
                      .join(' · ')}
                  </span>
                )}
              </div>
              <p className="mt-0.5 whitespace-pre-wrap text-xs">{answer}</p>
            </div>
          )}

          {superseded && <p className="text-[11px] text-muted-foreground">Retired unanswered.</p>}

          {revisionSteer && (
            <div className="rounded border border-agent-waiting/30 bg-agent-waiting/[0.05] px-2 py-1.5">
              <p className="text-[11px] font-medium text-muted-foreground">
                Correction ({revisionSteer.status === 'consumed' ? 'delivered' : 'queued'})
              </p>
              <p className="mt-0.5 text-xs">{revisionSteer.message}</p>
            </div>
          )}

          {canRevise && !reviseOpen && (
            <Button
              size="sm"
              variant="outline"
              className="h-6 gap-1 px-2 text-[11px]"
              onClick={() => setReviseOpen(true)}
            >
              <Compass className="h-3 w-3" />
              Revise answer
            </Button>
          )}

          {canRevise && reviseOpen && (
            <div className="space-y-1.5">
              <Textarea
                value={revision}
                onChange={(e) => setRevision(e.target.value)}
                placeholder="What should the agent do differently?"
                rows={2}
                className="text-xs"
              />
              {reviseError && <p className="text-[11px] text-agent-error">{reviseError}</p>}
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  className="h-6 px-2 text-[11px]"
                  disabled={!revision.trim() || revising}
                  onClick={handleRevise}
                >
                  {revising ? 'Sending…' : 'Send correction'}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  className="h-6 px-2 text-[11px]"
                  disabled={revising}
                  onClick={() => {
                    setReviseOpen(false);
                    setReviseError(null);
                  }}
                >
                  Cancel
                </Button>
              </div>
            </div>
          )}

          {influencedArtifacts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-[11px] text-muted-foreground">Influenced:</span>
              {influencedArtifacts.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="rounded border px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground"
                  onClick={() => focusWorkProduct({ kind: 'artifact', id: a.id })}
                >
                  {a.title || a.id}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function SteeringCompact({ steering }: { steering: IntentSteering[] }) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="space-y-0.5">
      <button
        type="button"
        className="flex items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-muted/40 transition-colors"
        onClick={() => setExpanded(!expanded)}
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0 text-muted-foreground" />
        )}
        <Compass className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-muted-foreground">Course corrections</span>
        <Badge variant="secondary" className="h-4 px-1 text-[9px]">
          {steering.length}
        </Badge>
      </button>
      {expanded && (
        <div className="ml-7 space-y-1.5">
          {steering.map((s) => (
            <div key={s.steerId} className="rounded-md border px-2.5 py-1.5 text-xs">
              <div className="flex items-center gap-1.5">
                <Badge
                  variant="outline"
                  className={cn(
                    'px-1 py-0 text-[9px]',
                    s.status === 'consumed' && 'bg-agent-success/10 text-agent-success',
                    s.status === 'pending' && 'bg-agent-waiting/10 text-agent-waiting',
                    s.status !== 'consumed' &&
                      s.status !== 'pending' &&
                      'bg-muted text-muted-foreground',
                  )}
                >
                  {s.status === 'consumed'
                    ? 'delivered'
                    : s.status === 'pending'
                      ? 'queued'
                      : 'superseded'}
                </Badge>
                {s.createdByName && (
                  <span className="text-[10px] text-muted-foreground">{s.createdByName}</span>
                )}
                {s.createdAt && (
                  <span className="ml-auto text-[10px] text-muted-foreground/70">
                    {formatTimelineTimestamp(s.createdAt)}
                  </span>
                )}
              </div>
              <p className="mt-1 whitespace-pre-wrap">{s.message}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function parseGateQuestions(
  raw: string | null,
): { text?: string; options?: { label: string }[] }[] {
  try {
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch (parseError) {
    void parseError;
    return [];
  }
}

function formatGateAnswer(
  answer: unknown,
  questions: { text?: string; options?: { label: string }[] }[],
): string {
  if (answer == null) return '';
  if (typeof answer === 'string') return answer;
  if (typeof answer !== 'object') return String(answer);
  const decision = (answer as { decision?: unknown }).decision;
  if (typeof decision === 'string') return decision;
  const structured = answer as { answers?: { selectedOptions?: unknown[]; freeText?: string }[] };
  if (Array.isArray(structured.answers)) {
    return structured.answers
      .map((a, idx) => {
        const selected = Array.isArray(a.selectedOptions)
          ? a.selectedOptions
              .map((opt) => {
                const optionIndex = typeof opt === 'number' ? opt : Number(opt);
                return Number.isInteger(optionIndex)
                  ? (questions[idx]?.options?.[optionIndex]?.label ?? String(opt))
                  : String(opt);
              })
              .join(', ')
          : '';
        const free = a.freeText?.trim() ?? '';
        const response = [selected, free].filter(Boolean).join(' · ');
        return response
          ? structured.answers!.length > 1
            ? `Q${idx + 1}: ${response}`
            : response
          : '';
      })
      .filter(Boolean)
      .join('\n');
  }
  return JSON.stringify(answer);
}
