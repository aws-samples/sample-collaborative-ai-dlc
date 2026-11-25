import type * as React from 'react';
import { Badge } from '@/components/ui/badge';
import { PageHeader } from '@/components/ui/page-header';
import { StatusPill } from '@/components/ui/status-pill';
import { MethodologyReleaseBadge } from '@/components/intent/MethodologyReleaseBadge';
import { openDecisions } from '@/components/intent/IntentOutcomeCallout';
import type { Intent, IntentGate, IntentStage } from '@/services/intents';
import { humanizeSlug } from '@/lib/displayNames';
import { ageLabel, deriveIntentStatus } from '@/lib/statusModel';
import { formatAbsolute } from '@/lib/timeAgo';

export type IntentHeaderIntent = Pick<
  Intent,
  'title' | 'status' | 'createdAt' | 'updatedAt' | 'completedAt' | 'scope'
> & {
  pendingHumanTaskId?: string | null;
  methodologyRelease?: Intent['methodologyRelease'];
  constructionGateAutonomy?: Intent['constructionGateAutonomy'];
};

const TERMINAL: ReadonlySet<Intent['status']> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

// Active states carry their elapsed time inside the pill ("Waiting for input ·
// 137 days"); terminal states show the pill alone and "51 days ago" beside it.
function pillSince(
  intent: IntentHeaderIntent,
  derived: ReturnType<typeof deriveIntentStatus>,
  oldestOpenWait: string | null | undefined,
): string | null | undefined {
  if (TERMINAL.has(intent.status)) return null;
  if (intent.status === 'WAITING') return oldestOpenWait ?? derived.since;
  if (derived.since) return derived.since;
  if (intent.status === 'CREATED' || intent.status === 'DRAFT') {
    return intent.createdAt ?? intent.updatedAt;
  }
  return null;
}

function EndedAgo({ at }: { at: string | null | undefined }) {
  const age = ageLabel(at);
  if (!at || !age) return null;
  return (
    <time
      dateTime={at}
      title={formatAbsolute(at)}
      className="text-xs text-muted-foreground tabular-nums"
    >
      {age} ago
    </time>
  );
}

// Below `sm` the shared header stacks the actions under the pills and clips
// the title to one line; the intent header keeps "…" on the title row and
// lets the title wrap to three lines instead (review W2 O9).
const INTENT_HEADER_CLASS =
  'max-sm:flex-row max-sm:items-start max-sm:gap-2 [&_h1]:max-sm:whitespace-normal [&_h1]:max-sm:line-clamp-3 [&_h1]:text-balance';

export interface IntentPageHeaderProps {
  intent: IntentHeaderIntent;
  lastActivityAt?: string | null;
  gates?: readonly IntentGate[];
  stages?: readonly IntentStage[];
  /** Discuss + `IntentActionsMenu`, the same set on every intent page. */
  actions?: React.ReactNode;
}

/**
 * The one header of every intent page (Overview, Work, Audit): the title, the
 * status pill with its age, scope and method badges, and the shared actions on
 * the right. The breadcrumb above it already links back to the space.
 */
export function IntentPageHeader({
  intent,
  lastActivityAt,
  gates,
  stages,
  actions,
}: IntentPageHeaderProps) {
  const derived = deriveIntentStatus(intent, { lastActivityAt, gates });
  const oldestOpenWait =
    intent.status === 'WAITING' && gates && stages
      ? openDecisions({ gates: [...gates], stages: [...stages] })[0]?.since
      : undefined;
  const release = intent.methodologyRelease ?? null;
  const autonomous = intent.constructionGateAutonomy === 'autonomous';
  const ended = TERMINAL.has(intent.status) ? (intent.completedAt ?? intent.updatedAt) : null;
  return (
    <PageHeader
      className={INTENT_HEADER_CLASS}
      title={intent.title?.trim() || 'Intent'}
      status={
        <StatusPill
          kind="intent"
          status={derived.key}
          since={pillSince(intent, derived, oldestOpenWait)}
          stalled={derived.stalled}
          size="md"
          hint
        />
      }
      meta={
        <>
          {ended ? <EndedAgo at={ended} /> : null}
          {intent.scope ? (
            <Badge variant="outline" size="sm" aria-label={`Scope: ${humanizeSlug(intent.scope)}`}>
              {humanizeSlug(intent.scope)}
            </Badge>
          ) : null}
          {release ? (
            // Shared badge renders 10 px monospace; the override keeps the 11 px
            // floor and the proportional face of the pill next to it.
            <span className="inline-flex [&_[data-testid=methodology-release-badge]]:font-sans [&_[data-testid=methodology-release-badge]]:text-2xs [&_[data-testid=methodology-release-badge]]:font-medium">
              <MethodologyReleaseBadge release={release} />
            </span>
          ) : null}
          {autonomous ? (
            <Badge variant="outline" size="sm" data-testid="construction-autonomy-badge">
              Autonomous construction
            </Badge>
          ) : null}
        </>
      }
      primaryAction={actions}
    />
  );
}
