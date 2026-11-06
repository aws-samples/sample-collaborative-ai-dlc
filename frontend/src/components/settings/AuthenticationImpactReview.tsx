import { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useProjectsCache } from '@/hooks/useProjectsCache';
import { cn } from '@/lib/utils';
import type { AgentAuthImpactReview, AgentAuthModeView } from '@/services/agents';
import {
  APPLIES_AT_NEXT_START,
  NOT_AFFECTED_MESSAGE,
  describeCandidate,
  summarizeImpact,
} from './agent-auth/impact';

type ReviewItem = AgentAuthImpactReview['items'][number];

const WORK_NOUNS: Record<string, string> = {
  Execution: 'Intent run',
  AgentInvocation: 'Running agent',
  AgentSelection: 'Agent that is starting',
  AgentConnectionHead: 'Shared connection',
  EnvironmentRevision: 'Published runtime environment',
  Compose: 'AI draft',
  QuorumEdit: 'Discussion edit',
};

const OUTCOME_LABELS: Record<string, string> = {
  continues: 'Keeps working',
  'loses-access': 'Will lose access',
  repair: 'Needs reconnecting',
  unknown: 'Could not be checked',
};

// Rendered only once a person opens the details, so space names load on demand.
function AffectedWorkList({ items }: { items: ReviewItem[] }) {
  const { projects } = useProjectsCache();
  const spaceName = (projectId: string | null) =>
    projectId === null
      ? 'Platform'
      : (projects.find((entry) => entry.project.id === projectId)?.project.name ?? 'A space');
  return (
    <ul className="mt-2 space-y-2">
      {items.map((item) => (
        <li key={item.key} className="rounded border bg-background p-2">
          <p className="font-medium">
            {spaceName(item.projectId)} · {WORK_NOUNS[item.type] ?? 'Work item'}
            {item.status ? ` (${item.status.toLowerCase()})` : ''}
          </p>
          <p>{OUTCOME_LABELS[item.outcome] ?? 'Effect unknown'}</p>
          <p className="text-muted-foreground">
            {item.reason} {item.action}
          </p>
        </li>
      ))}
    </ul>
  );
}

/**
 * Confirmation for a server-prepared authentication change. Says in plain words
 * what the change does and, only when work that already started is affected,
 * which work and what to do. Technical detail stays behind "Show details".
 */
export function AuthenticationImpactReview({
  review,
  modes,
  applying,
  onApply,
  onCancel,
}: {
  review: AgentAuthImpactReview;
  modes?: readonly AgentAuthModeView[];
  applying: boolean;
  onApply: () => void;
  onCancel: () => void;
}) {
  const headingId = useId();
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  // The panel replaces the button that opened it; move focus so keyboard and
  // screen reader users land on the question instead of losing their place.
  useEffect(() => headingRef.current?.focus(), [review.id]);

  const change = describeCandidate(review.candidate, modes);
  // The same reading decides whether a key save asks at all (reviewHasNoImpact).
  const { warnings, notes, heading } = summarizeImpact(review);
  const startedWork = review.items.filter((item) => item.outcome !== 'next-start');
  const warn = heading !== null;

  return (
    <section
      aria-labelledby={headingId}
      className={cn(
        'space-y-3 rounded-md border p-4 text-sm',
        warn && 'border-agent-warning/50 bg-agent-warning/5',
      )}
    >
      <h4
        id={headingId}
        ref={headingRef}
        tabIndex={-1}
        className="flex items-center gap-2 font-medium focus:outline-none"
      >
        {warn && <AlertTriangle className="h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />}
        {heading ?? 'Confirm this change'}
      </h4>
      <div className="space-y-1">
        {change.lines.map((line) => (
          <p key={line}>{line}</p>
        ))}
        {change.details.length > 0 && (
          <div className="break-all text-xs text-muted-foreground">
            {change.details.map((line) => (
              <p key={line.label}>
                {line.label}: {line.value}
              </p>
            ))}
          </div>
        )}
        <p className="text-muted-foreground">{APPLIES_AT_NEXT_START}</p>
      </div>
      {warn ? (
        <ul className="list-disc space-y-1 pl-5">
          {[...warnings, ...notes].map((entry) => (
            <li key={entry.key}>
              {entry.text}{' '}
              {entry.action && <span className="text-muted-foreground">{entry.action}</span>}
            </li>
          ))}
        </ul>
      ) : notes.length > 0 ? (
        notes.map((entry) => <p key={entry.key}>{entry.text}</p>)
      ) : (
        <p>{NOT_AFFECTED_MESSAGE}</p>
      )}
      {/* The server's notes (evidence limits, an interrupted write) stay available. */}
      {(startedWork.length > 0 || review.limitations.length > 0) && (
        <details className="text-xs" onToggle={(event) => setDetailsOpen(event.currentTarget.open)}>
          <summary className="cursor-pointer text-muted-foreground">Show details</summary>
          {detailsOpen && (
            <>
              {startedWork.length > 0 && <AffectedWorkList items={startedWork} />}
              {review.limitations.map((limitation) => (
                <p key={limitation} className="mt-2 text-muted-foreground">
                  {limitation}
                </p>
              ))}
            </>
          )}
        </details>
      )}
      <div className="flex gap-2">
        <Button type="button" size="sm" onClick={onApply} disabled={applying}>
          {applying ? 'Saving…' : warn ? 'Confirm anyway' : 'Confirm change'}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel} disabled={applying}>
          Cancel
        </Button>
      </div>
    </section>
  );
}
