// Composer panel — start a composer session for the DRAFT (front mode from
// the shared draft text, report mode from an uploaded analysis report) and
// render its outcome. The proposal is DATA: "Apply" writes it into the SHARED
// draft selection (scope / composed grid), never directly into the intent —
// the draft auto-save + Start re-validate everything server-side.

import { useCallback, useEffect, useRef, useState } from 'react';
import { intentsService, type ComposeSession } from '@/services/intents';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Input } from '@/components/ui/input';
import { AlertCircle, Check, FileUp, Loader2, Sparkles } from 'lucide-react';

interface Props {
  projectId: string;
  intentId: string;
  disabled?: boolean;
  /** Human accepts the proposal — write it into the shared draft selection. */
  onApply: (proposal: NonNullable<ComposeSession['proposal']>) => void;
}

const POLL_MS = 2500;

const summaryLine = (s: NonNullable<ComposeSession['validation']>['summary']) => {
  if (!s) return null;
  const parts = [
    `Runs ${s.executedStages} of ${s.totalStages} stages`,
    `${s.approvalGates} approval gate${s.approvalGates === 1 ? '' : 's'}`,
  ];
  if (s.perUnitStages > 0) parts.push(`${s.perUnitStages} fan out per unit of work`);
  return parts.join(' · ');
};

export function ComposePanel({ projectId, intentId, disabled, onApply }: Props) {
  const [sessions, setSessions] = useState<ComposeSession[]>([]);
  const [instructions, setInstructions] = useState('');
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [appliedId, setAppliedId] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const latest = sessions.length ? sessions[sessions.length - 1] : null;
  const pending = latest?.state === 'PENDING';

  // Seed from the store, then poll while a session is pending (compose runs
  // in the background container; polling keeps this panel dependency-free of
  // the intent WS provider).
  const reload = useCallback(async () => {
    try {
      const { composes } = await intentsService.listComposes(projectId, intentId);
      setSessions(composes);
    } catch {
      /* seed/poll is best-effort — the next action surfaces real errors */
    }
  }, [projectId, intentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!pending) return;
    const timer = window.setInterval(reload, POLL_MS);
    return () => window.clearInterval(timer);
  }, [pending, reload]);

  const startCompose = async (input: { reportKey?: string } = {}) => {
    setBusy(true);
    setError(null);
    try {
      const session = await intentsService.compose(projectId, intentId, {
        ...(instructions.trim() ? { instructions: instructions.trim() } : {}),
        ...input,
      });
      setSessions((prev) => [...prev, session]);
      setAppliedId(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Compose failed');
    } finally {
      setBusy(false);
    }
  };

  const uploadReport = async (file: File) => {
    setUploading(true);
    setError(null);
    try {
      const { uploadUrl, key } = await intentsService.composeReportUpload(projectId, intentId);
      const put = await fetch(uploadUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: await file.text(),
      });
      if (!put.ok) throw new Error(`report upload failed (${put.status})`);
      await startCompose({ reportKey: key });
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Report upload failed');
    } finally {
      setUploading(false);
      if (fileRef.current) fileRef.current.value = '';
    }
  };

  return (
    <div className="border rounded-md p-3 space-y-3" data-testid="compose-panel">
      <div className="flex items-center gap-2">
        <Sparkles className="h-4 w-4 text-muted-foreground" />
        <Label className="text-sm font-medium">Compose with AI</Label>
        <span className="text-xs text-muted-foreground font-normal">
          proposes which stages to run — you approve before anything applies
        </span>
      </div>

      <div className="flex gap-2">
        <Input
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="Optional steering, e.g. keep it lean, no infra changes…"
          className="text-sm"
          disabled={disabled || busy || pending}
          data-testid="compose-instructions"
        />
        <Button
          type="button"
          variant="secondary"
          onClick={() => startCompose()}
          disabled={disabled || busy || pending || uploading}
          data-testid="compose-start"
        >
          {busy || pending ? <Loader2 className="h-3.5 w-3.5 animate-spin mr-1.5" /> : null}
          {pending ? 'Composing…' : 'Compose'}
        </Button>
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          className="hidden"
          data-testid="compose-report-file"
          onChange={(e) => {
            const file = e.target.files?.[0];
            if (file) uploadReport(file);
          }}
        />
        <Button
          type="button"
          variant="outline"
          onClick={() => fileRef.current?.click()}
          disabled={disabled || busy || pending || uploading}
          title="Compose from an analysis report (JSON, e.g. a scanner export)"
          data-testid="compose-report"
        >
          {uploading ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <FileUp className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {error && (
        <p className="flex items-start gap-1.5 text-xs text-destructive">
          <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
          {error}
        </p>
      )}

      {latest?.state === 'FAILED' && (
        <div
          className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs"
          data-testid="compose-failed"
        >
          <span className="font-medium text-destructive">Compose failed:</span>{' '}
          {latest.failureReason ?? 'unknown reason'} — refine the prompt or steer and retry.
        </div>
      )}

      {latest?.state === 'COMPLETED' && latest.proposal && (
        <div
          className="rounded-md border bg-muted/30 px-3 py-2.5 space-y-2"
          data-testid="compose-proposal"
        >
          <div className="flex items-center gap-2 text-sm">
            <span className="font-medium">
              {latest.proposal.mode === 'matched'
                ? `Proposed scope: ${latest.proposal.scope}`
                : `Proposed custom grid: ${latest.proposal.scope}`}
            </span>
            {latest.source === 'match' && (
              <span className="text-[10px] uppercase tracking-wide rounded bg-muted px-1.5 py-0.5 text-muted-foreground">
                keyword match
              </span>
            )}
            {typeof latest.proposal.confidence === 'number' && latest.source !== 'match' && (
              <span className="text-xs text-muted-foreground">
                confidence {Math.round(latest.proposal.confidence * 100)}%
              </span>
            )}
          </div>
          {latest.validation?.summary && (
            <p className="text-xs text-foreground" data-testid="proposal-summary">
              {summaryLine(latest.validation.summary)}
            </p>
          )}
          {latest.proposal.rationale.length > 0 && (
            <ul className="text-xs text-muted-foreground list-disc pl-4 space-y-0.5">
              {latest.proposal.rationale.slice(0, 8).map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>
          )}
          {(latest.validation?.warnings?.length ?? 0) > 0 && (
            <p className="flex items-start gap-1.5 text-xs text-amber-600 dark:text-amber-500">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
              {latest.validation!.warnings.length} plan warning
              {latest.validation!.warnings.length === 1 ? '' : 's'} (inputs expected absent /
              degraded sections) — by design for lean runs.
            </p>
          )}
          <div className="flex items-center gap-2 pt-1">
            <Button
              type="button"
              size="sm"
              onClick={() => {
                onApply(latest.proposal!);
                setAppliedId(latest.composeId);
              }}
              disabled={disabled || appliedId === latest.composeId}
              data-testid="proposal-apply"
            >
              {appliedId === latest.composeId ? (
                <>
                  <Check className="h-3.5 w-3.5 mr-1" /> Applied
                </>
              ) : (
                'Apply proposal'
              )}
            </Button>
            <span className="text-[11px] text-muted-foreground">
              Applying only updates this draft — review and press Start when ready.
            </span>
          </div>
        </div>
      )}
    </div>
  );
}
