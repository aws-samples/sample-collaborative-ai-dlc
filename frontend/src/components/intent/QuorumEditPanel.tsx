import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Loader2, ShieldCheck, Sparkles, TriangleAlert, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import { useIntent } from '@/contexts/IntentContext';
import { intentsService, type QuorumEdit, type QuorumEditPlanItem } from '@/services/intents';

// Quorum-supported artifact edit sessions: the plan-approval surface and the
// live progress pane. Fed entirely from the detail DTO (`quorumEdits`) — the
// backend broadcasts payload-blind reload hints on every lifecycle change, so
// the panel re-renders through the shared IntentContext refetch. Progress
// output streams through the SAME OUTPUT#/agent.output machinery as stage
// transcripts, keyed under `qedit-<editId>`.

const ACTIVE_STATES = new Set(['PLANNING', 'AWAITING_APPROVAL', 'APPLYING']);

const stateBadge = (state: QuorumEdit['state']) => {
  switch (state) {
    case 'PLANNING':
      return { label: 'planning', className: 'bg-agent-running/10 text-agent-running' };
    case 'AWAITING_APPROVAL':
      return { label: 'awaiting approval', className: 'bg-agent-waiting/10 text-agent-waiting' };
    case 'APPLYING':
      return { label: 'applying', className: 'bg-agent-running/10 text-agent-running' };
    case 'SUCCEEDED':
      return { label: 'applied', className: 'bg-agent-success/10 text-agent-success' };
    case 'FAILED':
      return { label: 'failed', className: 'bg-destructive/10 text-destructive' };
    case 'REJECTED':
      return { label: 'rejected', className: 'bg-muted text-muted-foreground' };
    default:
      return { label: state.toLowerCase(), className: 'bg-muted text-muted-foreground' };
  }
};

export function QuorumEditPanel() {
  const { detail } = useIntent();
  const sessions = detail?.quorumEdits ?? [];
  const [showHistory, setShowHistory] = useState(false);

  const active = sessions.filter((q) => ACTIVE_STATES.has(q.state));
  const terminal = sessions
    .filter((q) => !ACTIVE_STATES.has(q.state))
    .toSorted((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));

  if (sessions.length === 0) return null;

  return (
    <Card>
      <CardHeader className="pb-3">
        <CardTitle className="flex items-center gap-2 text-sm">
          <Sparkles className="h-4 w-4" />
          Quorum edits
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Coordinated document edits: Quorum plans the downstream updates, you approve, it applies.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {active.map((q) => (
          <QuorumEditSession key={q.editId} edit={q} />
        ))}
        {terminal.length > 0 && (
          <div>
            <Button
              size="sm"
              variant="ghost"
              className="h-6 gap-1 px-2 text-[11px] text-muted-foreground"
              onClick={() => setShowHistory((v) => !v)}
            >
              <ChevronDown
                className={cn('h-3 w-3 transition-transform', showHistory && 'rotate-180')}
              />
              {terminal.length} past edit{terminal.length > 1 ? 's' : ''}
            </Button>
            {showHistory && (
              <div className="mt-2 space-y-2">
                {terminal.map((q) => (
                  <QuorumEditSession key={q.editId} edit={q} />
                ))}
              </div>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function QuorumEditSession({ edit }: { edit: QuorumEdit }) {
  const badge = stateBadge(edit.state);
  return (
    <div className="rounded-md border p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{edit.artifactTitle || edit.artifactId}</span>
        <Badge variant="outline" className={cn('px-1.5 py-0 text-[10px]', badge.className)}>
          {badge.label}
        </Badge>
        <span className="ml-auto text-[10px] text-muted-foreground/60">
          {edit.requestedByName || edit.requestedBy || ''}
          {edit.createdAt ? ` · ${new Date(edit.createdAt).toLocaleString()}` : ''}
        </span>
      </div>
      {edit.changeDescription && (
        <p className="mt-1 whitespace-pre-wrap text-xs text-muted-foreground">
          “{edit.changeDescription}”
        </p>
      )}
      {(edit.state === 'PLANNING' || edit.state === 'APPLYING') && (
        <QuorumEditProgress editId={edit.editId} />
      )}
      {edit.state === 'AWAITING_APPROVAL' && <QuorumEditApproval edit={edit} />}
      {edit.state === 'SUCCEEDED' && (
        <p className="mt-2 text-xs text-agent-success">
          Applied: target updated
          {edit.updatedArtifactIds?.length
            ? `, ${edit.updatedArtifactIds.length} downstream updated`
            : ''}
          {edit.verifiedArtifactIds?.length
            ? `, ${edit.verifiedArtifactIds.length} verified unaffected`
            : ''}
          {edit.failedArtifactIds?.length ? (
            <span className="text-agent-waiting">
              {' '}
              — {edit.failedArtifactIds.length} left stale (update failed)
            </span>
          ) : null}
        </p>
      )}
      {edit.state === 'FAILED' && (
        <p className="mt-2 text-xs text-destructive">
          Failed{edit.failureReason ? `: ${edit.failureReason}` : ''} — nothing beyond the reported
          artifacts was changed.
        </p>
      )}
      {edit.state === 'REJECTED' && (
        <p className="mt-2 text-xs text-muted-foreground">
          Plan rejected by {edit.decidedByName || 'a member'} — nothing was changed.
        </p>
      )}
    </div>
  );
}

// Live progress: the qedit output pane (durable OUTPUT# seed + live
// agent.output tail), exactly how stage transcripts render.
function QuorumEditProgress({ editId }: { editId: string }) {
  const { ensureOutputs, outputBuffers, outputVersion, outputPaneStatus } = useIntent();
  const key = `qedit-${editId}`;
  useEffect(() => {
    ensureOutputs(key);
  }, [key, ensureOutputs]);
  // outputVersion subscribes this component to buffer appends.
  void outputVersion;
  const text = outputBuffers.get(key) ?? '';
  const loading = outputPaneStatus(key) === 'loading';
  return (
    <div className="mt-2 rounded-md border bg-muted/20 p-2">
      <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
        <Loader2 className="h-3 w-3 animate-spin" />
        Quorum is working…
      </div>
      {(text.trim() || loading) && (
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-muted-foreground">
          {text.trim() || 'Loading progress…'}
        </pre>
      )}
    </div>
  );
}

function QuorumEditApproval({ edit }: { edit: QuorumEdit }) {
  const { projectId, intentId, reload } = useIntent();
  const items = useMemo(() => edit.plan?.items ?? [], [edit.plan]);
  // Everything starts included: updates apply, verify-unaffected clears the
  // drift marker with Quorum's rationale. Excluded items stay marked stale.
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [submitting, setSubmitting] = useState<'approve' | 'reject' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const decide = async (decision: 'approve' | 'reject') => {
    setSubmitting(decision);
    setError(null);
    try {
      await intentsService.decideQuorumEdit(projectId, intentId, edit.editId, {
        decision,
        ...(decision === 'approve'
          ? {
              approvedArtifactIds: items.map((i) => i.artifactId).filter((id) => !excluded.has(id)),
            }
          : {}),
      });
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Decision failed');
    } finally {
      setSubmitting(null);
    }
  };

  return (
    <div className="mt-2 space-y-2">
      {edit.plan?.summary && <p className="text-xs">{edit.plan.summary}</p>}
      {items.length === 0 ? (
        <p className="text-xs text-muted-foreground">
          No downstream artifacts are affected — approving updates only the target document.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map((item) => (
            <PlanItemRow
              key={item.artifactId}
              item={item}
              included={!excluded.has(item.artifactId)}
              onToggle={() => toggle(item.artifactId)}
            />
          ))}
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          className="h-7 gap-1.5"
          disabled={submitting != null}
          onClick={() => decide('approve')}
        >
          {submitting === 'approve' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <Check className="h-3 w-3" />
          )}
          Approve & apply
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 gap-1.5"
          disabled={submitting != null}
          onClick={() => decide('reject')}
        >
          {submitting === 'reject' ? (
            <Loader2 className="h-3 w-3 animate-spin" />
          ) : (
            <X className="h-3 w-3" />
          )}
          Reject
        </Button>
        <span className="text-[10px] text-muted-foreground/60">
          Excluded artifacts keep their “possibly stale” marker.
        </span>
      </div>
    </div>
  );
}

function PlanItemRow({
  item,
  included,
  onToggle,
}: {
  item: QuorumEditPlanItem;
  included: boolean;
  onToggle: () => void;
}) {
  const isUpdate = item.action === 'update';
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-2 rounded-md border px-2 py-1.5 transition-colors',
        included ? 'bg-background' : 'bg-muted/40 opacity-70',
      )}
    >
      <input
        type="checkbox"
        checked={included}
        onChange={onToggle}
        className="mt-0.5 h-3.5 w-3.5 accent-primary"
      />
      <span className="min-w-0 flex-1">
        <span className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs font-medium">{item.title || item.artifactId}</span>
          <Badge
            variant="outline"
            className={cn(
              'gap-1 px-1.5 py-0 text-[10px]',
              isUpdate
                ? 'border-agent-running/40 text-agent-running'
                : 'border-agent-success/40 text-agent-success',
            )}
          >
            {isUpdate ? (
              <Sparkles className="h-2.5 w-2.5" />
            ) : (
              <ShieldCheck className="h-2.5 w-2.5" />
            )}
            {isUpdate ? 'update' : 'verify unaffected'}
          </Badge>
          {item.unassessed && (
            <Badge
              variant="outline"
              className="gap-1 border-agent-waiting/40 px-1.5 py-0 text-[10px] text-agent-waiting"
              title="Quorum did not explicitly assess this closure member"
            >
              <TriangleAlert className="h-2.5 w-2.5" />
              unassessed
            </Badge>
          )}
        </span>
        {item.rationale && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground">{item.rationale}</span>
        )}
        {isUpdate && item.proposedChange && (
          <span className="mt-0.5 block text-[11px] text-muted-foreground/80">
            → {item.proposedChange}
          </span>
        )}
      </span>
    </label>
  );
}
