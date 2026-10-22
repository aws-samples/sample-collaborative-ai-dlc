import { useEffect, useMemo, useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
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
// Large sites list hundreds of projects, so the list is searchable by name and
// key, and each project shows its type (Product Discovery, Software, ...).
const PROJECT_TYPE_LABEL: Record<string, string> = {
  software: 'Software',
  business: 'Business',
  service_desk: 'Service management',
  product_discovery: 'Product Discovery',
};

const matchesFilter = (project: ExternalProject, filter: string) => {
  const f = filter.trim().toLowerCase();
  return !f || project.name.toLowerCase().includes(f) || project.key.toLowerCase().includes(f);
};

export function JiraProjectPickerDialog({ open, onOpenChange, onConfirm }: Props) {
  const meta = getTrackerProvider('jira-cloud');
  const [projects, setProjects] = useState<ExternalProject[]>([]);
  const [loading, setLoading] = useState(false);
  const [chosenKey, setChosenKey] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');

  const visible = useMemo(
    () => projects.filter((p) => matchesFilter(p, filter)),
    [projects, filter],
  );

  // A selection the search hides is cleared, so Add never submits a project
  // the user can no longer see.
  const changeFilter = (value: string) => {
    setFilter(value);
    const chosen = projects.find((p) => p.key === chosenKey);
    if (chosen && !matchesFilter(chosen, value)) setChosenKey(null);
  };

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setProjects([]);
    setChosenKey(null);
    setFilter('');
    setError(null);
    setLoading(true);
    trackersService
      .listExternalProjects(meta.id, meta.instance)
      .then((list) => {
        if (cancelled) return;
        setProjects(list);
        // No preselection: with hundreds of projects the first one is never
        // the right one, and Add would silently bind it.
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
      <DialogContent className="sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Add Jira project</DialogTitle>
          <DialogDescription>
            Pick the Jira project to bind to this collaborative space. The "Start a sprint from a
            Jira issue" panel will list issues from this project.
          </DialogDescription>
        </DialogHeader>
        {!loading && !error && projects.length > 0 && (
          <Input
            value={filter}
            onChange={(e) => changeFilter(e.target.value)}
            placeholder={`Search ${projects.length} projects by name or key…`}
            aria-label="Search Jira projects"
            autoFocus
          />
        )}
        <div className="space-y-2 py-2 max-h-80 overflow-y-auto">
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading projects…</p>
          ) : error ? (
            <p className="text-sm text-destructive">{error}</p>
          ) : projects.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No Jira projects accessible. Check that your Atlassian user has read access.
            </p>
          ) : visible.length === 0 ? (
            <p className="text-sm text-muted-foreground">No projects match "{filter.trim()}".</p>
          ) : (
            visible.map((p) => (
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
                  <p className="font-medium text-sm wrap-anywhere">{p.name}</p>
                  <p className="text-xs text-muted-foreground">
                    <span className="font-mono">{p.key}</span>
                    {p.projectTypeKey && (
                      <> · {PROJECT_TYPE_LABEL[p.projectTypeKey] ?? p.projectTypeKey}</>
                    )}
                  </p>
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
