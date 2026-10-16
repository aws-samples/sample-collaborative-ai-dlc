import { useCallback, useEffect, useRef, useState } from 'react';
import {
  intentsService,
  type TrackerAttachmentCandidate,
  type TrackerAttachmentImportResult,
} from '@/services/intents';
import { Button } from '@/components/ui/button';
import { Loader2 } from 'lucide-react';

type Result = TrackerAttachmentCandidate &
  (TrackerAttachmentImportResult | { status: 'pending' | 'importing' });

export function TrackerAttachmentImport({
  projectId,
  intentId,
  autoImport,
  disabled,
  onAutoImportStarted,
  onBusyChange,
  onImported,
}: {
  projectId: string;
  intentId: string;
  autoImport: boolean;
  disabled: boolean;
  onAutoImportStarted: () => void;
  onBusyChange: (busy: boolean) => void;
  onImported: () => void;
}) {
  const [results, setResults] = useState<Result[]>([]);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const running = useRef(false);
  const autoStarted = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const run = useCallback(async () => {
    if (running.current) return;
    running.current = true;
    setBusy(true);
    onBusyChange(true);
    setMessage(null);
    setResults([]);
    try {
      const discovery = await intentsService.trackerAttachments(projectId, intentId);
      if (!mounted.current) return;
      if (!discovery.attachments) {
        setMessage(discovery.reason || 'Could not discover issue attachments.');
        return;
      }
      const candidates = discovery.attachments;
      if (!candidates.length) setMessage('No issue attachments found.');
      setResults(candidates.map((file) => ({ ...file, status: 'pending' })));
      for (const file of candidates) {
        if (!mounted.current) break;
        setResults((current) =>
          current.map((row) => (row.id === file.id ? { ...file, status: 'importing' } : row)),
        );
        let result: TrackerAttachmentImportResult;
        try {
          result = file.skipReason
            ? { status: 'skipped', reason: file.skipReason }
            : await intentsService.importTrackerAttachment(projectId, intentId, file.id);
        } catch (error) {
          result = {
            status: 'failed',
            reason:
              error instanceof Error
                ? error.message
                : 'Import failed. Retry to check whether the file arrived.',
          };
        }
        if (!mounted.current) break;
        setResults((current) =>
          current.map((row) => (row.id === file.id ? { ...file, ...result } : row)),
        );
        if (result.status === 'imported') onImported();
      }
    } catch (error) {
      if (mounted.current)
        setMessage(error instanceof Error ? error.message : 'Could not import issue attachments.');
    } finally {
      running.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusyChange(false);
      }
    }
  }, [projectId, intentId, onBusyChange, onImported]);

  useEffect(() => {
    if (!autoImport || autoStarted.current || disabled) return;
    autoStarted.current = true;
    onAutoImportStarted();
    void run();
  }, [autoImport, disabled, onAutoImportStarted, run]);

  return (
    <div className="space-y-2 rounded-md border p-3" aria-label="Tracker attachment import">
      <div className="flex items-center justify-between gap-3">
        <span className="text-sm font-medium">Files from the source issue</span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || busy}
          onClick={() => void run()}
        >
          {busy && <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" />}
          {busy ? 'Importing…' : results.length ? 'Retry import' : 'Import attachments'}
        </Button>
      </div>
      {message && (
        <p className="text-xs text-muted-foreground" role="status">
          {message}
        </p>
      )}
      {results.length > 0 && (
        <ul className="space-y-1 text-xs" aria-live="polite">
          {results.map((file) => (
            <li key={file.id}>
              {file.status === 'imported' ? file.attachment.filename : file.filename}: {file.status}
              {'reason' in file && file.reason ? ` — ${file.reason}` : ''}
            </li>
          ))}
        </ul>
      )}
      <p className="text-xs text-muted-foreground">
        File failures do not change the imported issue text. Files already imported are kept once.
      </p>
    </div>
  );
}
