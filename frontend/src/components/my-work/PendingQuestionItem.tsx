import { useNavigate } from 'react-router';
import { ArrowRight, Users } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { humanizeStageId } from '@/components/intent/documentHelpers';
import { getTimeAgo } from '@/lib/timeAgo';
import type { PendingQuestion } from '@/services/myWork';

const KIND_LABELS: Record<string, string> = {
  question: 'Question',
  approval: 'Approval',
  'review-verdict': 'Review verdict',
  validation: 'Stage review',
};

function kindLabel(item: PendingQuestion): string {
  if (item.checkpoint) return 'Checkpoint';
  return KIND_LABELS[item.kind] ?? 'Question';
}

// Same fallbacks as the intent screen's gate tabs (gateTabLabel).
function summaryLabel(item: PendingQuestion): string {
  if (item.summary) return item.summary;
  if (item.checkpoint) return humanizeStageId(item.checkpoint);
  if (item.kind === 'validation') return 'Review required';
  return 'Approval required';
}

export function pendingQuestionHref(item: PendingQuestion): string {
  const { projectId, intentId, humanTaskId, view } = item.target;
  const base = `/space/${encodeURIComponent(projectId)}/intent/${encodeURIComponent(intentId)}`;
  return view === 'review'
    ? `${base}/review/${encodeURIComponent(humanTaskId)}`
    : `${base}?gate=${encodeURIComponent(humanTaskId)}`;
}

export function PendingQuestionItem({ item }: { item: PendingQuestion }) {
  const navigate = useNavigate();
  const spaceName = item.projectName || 'Space';
  const intentTitle = item.intentTitle || 'Intent';
  const lane = item.unitSlug
    ? item.sectionIndex != null
      ? `${item.unitSlug}, section ${item.sectionIndex + 1}`
      : item.unitSlug
    : null;
  const context = [item.stageId ? humanizeStageId(item.stageId) : null, lane]
    .filter(Boolean)
    .join(' · ');
  const created = item.createdAt ? new Date(item.createdAt) : null;
  const createdValid = created && !Number.isNaN(created.getTime());

  return (
    <li className="flex flex-col gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-center">
      <div className="min-w-0 flex-1 space-y-1.5">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
          <span className="font-medium text-foreground">{spaceName}</span>
          <span aria-hidden="true">/</span>
          <span className="truncate">{intentTitle}</span>
          {createdValid && (
            <>
              <span aria-hidden="true">·</span>
              <time dateTime={item.createdAt!} title={created.toLocaleString()}>
                {getTimeAgo(item.createdAt!)}
              </time>
            </>
          )}
        </div>
        <p className="text-sm font-medium leading-snug break-words">{summaryLabel(item)}</p>
        <div className="flex flex-wrap items-center gap-2">
          <Badge variant="secondary" className="text-[11px]">
            {kindLabel(item)}
          </Badge>
          {item.questionCount != null && item.questionCount > 1 && (
            <span className="text-xs text-muted-foreground">{item.questionCount} questions</span>
          )}
          {context && <span className="text-xs text-muted-foreground">{context}</span>}
          {/* Every value, including unknown future ones, reads as open: the
              list never implies an individual assignment. */}
          <Badge variant="outline" className="gap-1 text-[11px] font-normal">
            <Users className="h-3 w-3" aria-hidden="true" />
            Open to eligible members
          </Badge>
        </div>
      </div>
      <Button
        size="sm"
        variant="outline"
        className="shrink-0 gap-1.5 self-start sm:self-center"
        aria-label={`Open question in ${intentTitle}, ${spaceName}`}
        onClick={() => navigate(pendingQuestionHref(item))}
      >
        Open question
        <ArrowRight className="h-3.5 w-3.5" aria-hidden="true" />
      </Button>
    </li>
  );
}
