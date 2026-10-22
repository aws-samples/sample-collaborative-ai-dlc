import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { ApiError } from '@/services/api';
import { trackersService, type ExternalProject } from '@/services/trackers';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called once the user has confirmed a Jira project. The parent persists
  // the binding (so the dialog stays presentation-only).
  onConfirm: (chosen: ExternalProject) => Promise<void>;
  // Omitted after returning from OAuth to prevent repeated redirects.
  onAuthorize?: (signal: AbortSignal) => Promise<void>;
}

// Lists Jira projects accessible to the connected user and lets them pick
// one to bind to the current collaborative project. Self-contained so the
// fetch + radio-list state doesn't sprawl across ProjectSettings.
export function JiraProjectPickerDialog({ open, onOpenChange, onConfirm, onAuthorize }: Props) {
  const meta = getTrackerProvider('jira-cloud');
  const [projects, setProjects] = useState<ExternalProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [authorizing, setAuthorizing] = useState(false);
  const request = useRef<AbortController | null>(null);

  const handleError = useCallback(
    async (err: unknown, signal: AbortSignal) => {
      if (signal.aborted) return;
      if (err instanceof ApiError && err.body?.reconnect === true && onAuthorize) {
        setAuthorizing(true);
        try {
          await onAuthorize(signal);
          return;
        } catch (authError) {
          if (signal.aborted) return;
          setAuthorizing(false);
          setError(authError instanceof Error ? authError.message : 'Failed to authorize Jira');
          return;
        }
      }
      setError(err instanceof Error ? err.message : 'Failed to load Jira projects');
    },
    [onAuthorize],
  );

  useEffect(() => {
    if (!open) return;
    const controller = new AbortController();
    request.current = controller;
    const { signal } = controller;
    setProjects([]);
    setChosenKey(null);
    setError(null);
    setAuthorizing(false);
    setSaving(false);
    setLoading(true);
    trackersService
      .listExternalProjects(meta.id, meta.instance)
      .then((list) => {
        if (signal.aborted) return;
        setProjects(list);
        if (list.length > 0) setChosenKey(list[0].key);
      })
      .catch((err: unknown) => {
        return handleError(err, signal);
      })
      .finally(() => {
        if (!signal.aborted) setLoading(false);
      });
    return () => {
      controller.abort();
    };
  }, [open, meta.id, meta.instance, handleError]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (!nextOpen) request.current?.abort();
    onOpenChange(nextOpen);
  };

  const handleConfirm = async () => {
    const chosen = projects.find((p) => p.key === chosenKey);
    const signal = request.current?.signal;
    if (!chosen || !signal || signal.aborted) return;
    setSaving(true);
    try {
      await onConfirm(chosen);
      if (!signal.aborted) onOpenChange(false);
    } catch (err) {
      if (!signal.aborted) {
        setError(err instanceof Error ? err.message : 'Failed to add Jira project');
      }
    } finally {
      if (!signal.aborted) setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Jira project</DialogTitle>
          <DialogDescription>
            Pick the Jira project to bind to this collaborative space. The "Start a sprint from a
            Jira issue" panel will list issues from this project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4 max-h-72 overflow-y-auto">
          {authorizing ? (
            <p className="text-sm text-muted-foreground">Connecting to Jira…</p>
          ) : loading ? (
            <p className="text-sm text-muted-foreground">Loading projects…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Jira projects accessible. Check that your Atlassian user has read access.
            </p>
          ) : (
            projects.map((p) => (
              <label
                key={p.key}
                className={cn(
                  'flex items-start gap-3 p-3 rounded-md border cursor-pointer hover:bg-accent/30',
                  chosenKey === p.key && 'border-primary bg-primary/5',
                )}
              >
                <input
                  type="radio"
                  name="jiraProject"
                  value={p.key}
                  checked={chosenKey === p.key}
                  onChange={() => setChosenKey(p.key)}
                  className="mt-1 accent-primary"
                />
                <div className="flex-1 min-w-0">
                  <p className="font-medium text-sm">{p.name}</p>
                  <p className="text-xs text-muted-foreground font-mono">{p.key}</p>
                </div>
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button
            type="button"
            onClick={handleConfirm}
            disabled={saving || authorizing || !chosenKey}
          >
            {saving ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
