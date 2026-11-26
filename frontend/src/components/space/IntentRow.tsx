import { Link } from 'react-router';
import { Loader2 } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { Intent, IntentDetail } from '@/services/intents';
import { StatusPill } from '@/components/ui/status-pill';
import { RelativeTime } from '@/components/ui/relative-time';
import { useIntentStatus } from '@/lib/statusModel';
import { intentAttention } from '@/lib/sprintStatus';
import { intentEntryPath } from '@/lib/intentEntry';
import { useQueryData } from '@/hooks/useQueryData';
import { qk } from '@/lib/queryKeys';
import { isUntitledIntent } from './intentGrouping';
import { intentRowMeta } from './intentRowMeta';

export interface IntentRowProps {
  projectId: string;
  intent: Intent;
  now?: number;
  /** Secondary row actions (a `RowActions` menu); never the navigation itself. */
  actions?: React.ReactNode;
  deleting?: boolean;
}

export function intentRowTitle(intent: Pick<Intent, 'title' | 'status'>): string {
  if (!isUntitledIntent(intent.title)) return intent.title as string;
  return intent.status === 'DRAFT' ? 'Untitled draft' : 'Untitled intent';
}

/** Gates from an already-cached detail (idle/hover prefetch); never triggers a read. */
function useCachedGates(projectId: string, intentId: string, enabled: boolean) {
  return useQueryData<IntentDetail>(enabled ? qk.intentDetail(projectId, intentId) : null)?.gates;
}

export function IntentRow({ projectId, intent, now, actions, deleting = false }: IntentRowProps) {
  // Same derivation as the intent header once its detail is cached (oldest
  // open gate); the summary alone carries no waiting age (R3-5).
  const derived = useIntentStatus(projectId, intent, { now });
  const attention = intentAttention(intent);
  // The shell's delegated listener warms the link (and skips it while
  // aria-disabled, i.e. deleting).
  const href = intentEntryPath(projectId, intent);
  const gates = useCachedGates(projectId, intent.id, attention === 'input');
  const untitled = isUntitledIntent(intent.title);
  const meta = intentRowMeta(intent, { now, gates, since: derived.since, derived });
  const metaParts = meta.parts;
  const hasMeta = metaParts.length > 0 || meta.time !== null;

  return (
    <li
      data-intent-id={intent.id}
      data-group-attention={attention === 'input' || attention === 'resume' ? '' : undefined}
      aria-busy={deleting || undefined}
      className={cn(
        'group relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1.5 px-3 py-2.5 transition-colors',
        'sm:grid-cols-[minmax(0,1fr)_auto_auto]',
        deleting ? 'opacity-50' : 'hover:bg-accent/50 focus-within:bg-accent/50',
      )}
    >
      <Link
        to={href}
        aria-disabled={deleting || undefined}
        tabIndex={deleting ? -1 : undefined}
        className={cn(
          'col-start-1 row-start-1 line-clamp-2 min-w-0 self-center text-sm font-medium leading-5',
          'after:absolute after:inset-0 after:z-10 focus-visible:outline-none focus-visible:after:ring-2 focus-visible:after:ring-inset focus-visible:after:ring-ring',
          untitled && 'italic text-muted-foreground',
          deleting && 'pointer-events-none',
        )}
      >
        {intentRowTitle(intent)}
      </Link>

      <div className="pointer-events-none col-start-1 row-start-2 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 sm:contents">
        <span className="pointer-events-none flex shrink-0 items-center sm:col-start-2 sm:row-span-2 sm:row-start-1">
          {deleting ? (
            <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
              <Loader2 aria-hidden="true" className="h-3.5 w-3.5 motion-safe:animate-spin" />
              Deleting…
            </span>
          ) : attention === 'resume' ? (
            <StatusPill kind="gate" status="resume_required" />
          ) : (
            <StatusPill kind="intent" status={derived.key} stalled={derived.stalled} />
          )}
        </span>
        {hasMeta ? (
          <span
            data-testid="intent-row-meta"
            className="pointer-events-none min-w-0 basis-full break-words text-xs text-muted-foreground sm:col-start-1 sm:row-start-2 sm:basis-auto sm:truncate"
          >
            {metaParts.map((part, index) => (
              <span key={part}>
                {index > 0 ? <span aria-hidden="true"> · </span> : null}
                {part}
              </span>
            ))}
            {meta.time ? (
              <>
                {metaParts.length > 0 ? <span aria-hidden="true"> · </span> : null}
                <RelativeTime
                  value={meta.time.value}
                  prefix={meta.time.prefix}
                  now={now}
                  format="age"
                />
              </>
            ) : null}
          </span>
        ) : null}
      </div>

      {actions ? (
        <span className="relative z-20 col-start-2 row-span-2 row-start-1 flex self-center sm:col-start-3">
          {actions}
        </span>
      ) : null}
    </li>
  );
}
