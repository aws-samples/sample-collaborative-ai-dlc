import { useEffect, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { trackersService, type ExternalProject } from '@/services/trackers';
import { getTrackerProvider } from '@/lib/trackerProviders';
import { cn } from '@/lib/utils';

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // Called once the user has confirmed a Jira project. The parent persists
  // the binding (so the dialog stays presentation-only).
  onConfirm: (chosen: ExternalProject) => Promise<void>;
}

// Lists Jira projects accessible to the connected user and lets them pick
// one to bind to the current collaborative project. Self-contained so the
// fetch + radio-list state doesn't sprawl across ProjectSettings.
export function JiraProjectPickerDialog({ open, onOpenChange, onConfirm }: Props) {
  const meta = getTrackerProvider('jira-cloud');
  const [projects, setProjects] = useState<ExternalProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProjects([]);
    setChosenKey(null);
    setError(null);
    setLoading(true);
    trackersService
      .listExternalProjects(meta.id, meta.instance)
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        if (list.length > 0) setChosenKey(list[0].key);
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : 'Failed to list Jira projects');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, meta.id, meta.instance]);

  const handleConfirm = async () => {
    const chosen = projects.find((p) => p.key === chosenKey);
    if (!chosen) return;
    setSaving(true);
    try {
      await onConfirm(chosen);
      onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add Jira project');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Add Jira project</DialogTitle>
          <DialogDescription>
            Pick the Jira project to bind to this collaborative space. The "Start a sprint from a
            Jira issue" panel will list issues from this project.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 py-4 max-h-72 overflow-y-auto">
          {loading ? (
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
            onClick={() => onOpenChange(false)}
            disabled={saving}
          >
            Cancel
          </Button>
          <Button type="button" onClick={handleConfirm} disabled={saving || !chosenKey}>
            {saving ? 'Adding…' : 'Add'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
